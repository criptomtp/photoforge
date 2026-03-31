import { supabaseAdmin } from "./supabase/admin";

export const TOKEN_COSTS = {
  prompt_gen: 0.10,   // Gemini 2.5 Pro call (1 per generation)
  image_gen: 0.50,    // Gemini 2.5 Flash Image (×8 per generation)
  total_per_run: 0.10 + 0.50 * 8, // = 4.10 tokens per full generation
};

/**
 * Resolves which Gemini API key to use and validates token balance.
 * Returns { apiKey, byok, freeQuota } or throws with a user-facing message.
 * freeQuota=true means the generation is covered by the free monthly quota (no token deduction).
 */
export async function resolveApiKey(userId: string): Promise<{
  apiKey: string | null;
  byok: boolean;
  freeQuota: boolean;
}> {
  // 1. Check user's own BYOK key
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("gemini_api_key, token_balance, plan, generations_used, generations_limit")
    .eq("id", userId)
    .single();

  if (profile?.gemini_api_key) {
    const { decrypt } = await import("./crypto");
    return { apiKey: decrypt(profile.gemini_api_key), byok: true, freeQuota: false };
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

  // 2. Free plan monthly quota — no tokens needed
  const plan: string = profile?.plan ?? "free";
  const generationsUsed: number = Number(profile?.generations_used ?? 0);
  const generationsLimit: number = Number(profile?.generations_limit ?? 0);

  if (plan === "free" && generationsUsed < generationsLimit) {
    const apiKey = await getPlatformKey();
    return { apiKey, byok: false, freeQuota: true };
  }

  // 3. Paid plans / extra generations — check token balance
  const balance: number = Number(profile?.token_balance ?? 0);
  const required = TOKEN_COSTS.total_per_run;

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
  return { apiKey, byok: false, freeQuota: false };
}

/**
 * Deducts tokens from user balance and records transaction.
 * Only called when byok = false.
 */
export async function deductTokens(
  userId: string,
  generationId: string,
  imagesGenerated: number
): Promise<void> {
  const cost = TOKEN_COSTS.prompt_gen + TOKEN_COSTS.image_gen * imagesGenerated;

  // Atomic update using RPC to avoid race conditions
  const { data: newBalance, error } = await supabaseAdmin.rpc(
    "deduct_tokens",
    { p_user_id: userId, p_amount: cost }
  );

  if (error) throw new Error(`Token deduction failed: ${error.message}`);

  await supabaseAdmin.from("token_transactions").insert({
    user_id: userId,
    amount: -cost,
    kind: "generation",
    description: `Генерація: ${imagesGenerated} фото`,
    generation_id: generationId,
    balance_after: newBalance,
  });
}

/**
 * Credits tokens to user (purchase, bonus, etc.)
 */
export async function creditTokens(
  userId: string,
  amount: number,
  kind: "purchase" | "bonus" | "refund",
  description: string
): Promise<void> {
  const { data: newBalance, error } = await supabaseAdmin.rpc(
    "credit_tokens",
    { p_user_id: userId, p_amount: amount }
  );

  if (error) throw new Error(`Token credit failed: ${error.message}`);

  await supabaseAdmin.from("token_transactions").insert({
    user_id: userId,
    amount,
    kind,
    description,
    balance_after: newBalance,
  });
}
