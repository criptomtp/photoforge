import { supabaseAdmin } from "./supabase/admin";
import { TOKEN_COSTS, FULL_RUN_COST, costForAngles } from "./angles";
import { ADMIN_EMAIL } from "./constants";

export { TOKEN_COSTS, FULL_RUN_COST, costForAngles };

/** Owner/admin allowlist: ADMIN_EMAIL env + the app_admins table (RLS-protected,
 *  read here via the service-role client). */
async function isPlatformAdmin(email?: string): Promise<boolean> {
  if (!email) return false;
  const e = email.toLowerCase();
  if (e === ADMIN_EMAIL.toLowerCase()) return true;
  const { data } = await supabaseAdmin
    .from("app_admins")
    .select("email")
    .eq("email", e)
    .maybeSingle();
  return !!data;
}

/**
 * Resolves which Gemini API key to use and validates token balance.
 * Returns { apiKey, byok, freeQuota, admin } or throws with a user-facing message.
 * freeQuota=true means the generation is covered by the free monthly quota (no token deduction).
 * admin=true means the owner/admin runs unlimited on the platform key (no quota, no token charge).
 */
export async function resolveApiKey(userId: string, email?: string): Promise<{
  apiKey: string | null;
  byok: boolean;
  freeQuota: boolean;
  admin: boolean;
}> {
  // 1. Check user's own BYOK key
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("gemini_api_key, token_balance, plan, generations_used, generations_limit")
    .eq("id", userId)
    .single();

  if (profile?.gemini_api_key) {
    const { decrypt } = await import("./crypto");
    return { apiKey: decrypt(profile.gemini_api_key), byok: true, freeQuota: false, admin: false };
  }

  // Platform key resolver: Vertex AI (env) takes priority over AI Studio (DB)
  async function getPlatformKey(): Promise<string | null> {
    if (process.env.GOOGLE_VERTEX_SA_KEY) {
      return null; // null = use Vertex AI with service account
    }
    const { data: settings } = await supabaseAdmin
      .from("platform_settings")
      .select("gemini_api_key")
      .eq("id", 1)
      .single();

    if (!settings?.gemini_api_key) {
      throw new Error(
        "Gemini API не налаштовано. Зверніться до адміністратора."
      );
    }
    const { decrypt } = await import("./crypto");
    return decrypt(settings.gemini_api_key);
  }

  // 1b. Owner/admin — unlimited platform usage (no quota, no token charge).
  if (await isPlatformAdmin(email)) {
    const apiKey = await getPlatformKey();
    return { apiKey, byok: false, freeQuota: false, admin: true };
  }

  // 2. Free plan monthly quota — no tokens needed
  const plan: string = profile?.plan ?? "free";
  const generationsUsed: number = Number(profile?.generations_used ?? 0);
  const generationsLimit: number = Number(profile?.generations_limit ?? 0);

  if (plan === "free" && generationsUsed < generationsLimit) {
    const apiKey = await getPlatformKey();
    return { apiKey, byok: false, freeQuota: true, admin: false };
  }

  // 3. Paid plans / extra generations — check token balance.
  // We require enough for at least one image; per-angle deduction happens after.
  const balance: number = Number(profile?.token_balance ?? 0);
  const required = TOKEN_COSTS.prompt_gen + TOKEN_COSTS.image_gen;

  if (balance < required) {
    if (plan === "free") {
      throw new Error(
        `Вичерпано безкоштовний ліміт (${generationsLimit} генерацій/міс). ` +
        `Поповніть баланс токенів або додайте власний Gemini API ключ у Налаштуваннях.`
      );
    }
    throw new Error(
      `Недостатньо токенів (є ${balance.toFixed(2)}, потрібно ${required.toFixed(2)}). ` +
      `Поповніть баланс або додайте власний Gemini API ключ у Налаштуваннях.`
    );
  }

  const apiKey = await getPlatformKey();
  return { apiKey, byok: false, freeQuota: false, admin: false };
}

/**
 * Credits tokens to user (purchase, bonus, etc.).
 * Atomic: balance update + ledger row commit in a single DB transaction (RPC),
 * so the balance and the audit trail can never diverge on a partial failure.
 */
export async function creditTokens(
  userId: string,
  amount: number,
  kind: "purchase" | "bonus" | "refund",
  description: string
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("credit_tokens_tx", {
    p_user_id: userId,
    p_amount: amount,
    p_kind: kind,
    p_description: description,
    p_generation_id: null,
  });

  if (error) throw new Error(`Token credit failed: ${error.message}`);
}

/**
 * Reserves (debits) the FULL cost of a run up-front, before any paid AI calls.
 * The deduct_tokens_tx RPC locks the row, rejects an insufficient balance, and
 * writes the ledger row atomically — so an underfunded request is rejected
 * before it can burn any Gemini/Vertex spend, and concurrent runs are serialized.
 * Only call when byok = false and freeQuota = false.
 */
export async function reserveTokens(
  userId: string,
  generationId: string,
  angleCount: number,
  tokenMultiplier = 1
): Promise<number> {
  const cost = costForAngles(angleCount, tokenMultiplier);

  const { error } = await supabaseAdmin.rpc("deduct_tokens_tx", {
    p_user_id: userId,
    p_amount: cost,
    p_kind: "generation",
    p_description: `Генерація (резерв): ${angleCount} фото`,
    p_generation_id: generationId,
  });

  if (error) throw new Error(`Token reservation failed: ${error.message}`);

  return cost;
}

/**
 * Refunds part (or all) of a previously reserved run when some/all images fail.
 */
export async function refundTokens(
  userId: string,
  generationId: string,
  amount: number,
  reason: string
): Promise<void> {
  if (amount <= 0) return;

  const { error } = await supabaseAdmin.rpc("credit_tokens_tx", {
    p_user_id: userId,
    p_amount: amount,
    p_kind: "refund",
    p_description: reason,
    p_generation_id: generationId,
  });

  if (error) throw new Error(`Token refund failed: ${error.message}`);
}
