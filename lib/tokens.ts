import { createClient } from "@supabase/supabase-js";

// Service-role client for atomic token operations
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const TOKEN_COSTS = {
  prompt_gen: 0.10,   // Gemini 2.5 Pro call (1 per generation)
  image_gen: 0.50,    // Gemini 2.5 Flash Image (×8 per generation)
  total_per_run: 0.10 + 0.50 * 8, // = 4.10 tokens per full generation
};

/**
 * Resolves which Gemini API key to use and validates token balance.
 * Returns { apiKey, byok } or throws with a user-facing message.
 */
export async function resolveApiKey(userId: string): Promise<{
  apiKey: string;
  byok: boolean;
}> {
  // 1. Check user's own BYOK key
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("gemini_api_key, token_balance")
    .eq("id", userId)
    .single();

  if (profile?.gemini_api_key) {
    const { decrypt } = await import("./crypto");
    return { apiKey: decrypt(profile.gemini_api_key), byok: true };
  }

  // 2. Check platform key + token balance
  const balance: number = Number(profile?.token_balance ?? 0);
  const required = TOKEN_COSTS.total_per_run;

  if (balance < required) {
    throw new Error(
      `Недостатньо токенів (є ${balance.toFixed(2)}, потрібно ${required.toFixed(2)}). ` +
      `Поповніть баланс або додайте власний Gemini API ключ у Налаштуваннях.`
    );
  }

  const { data: settings } = await supabaseAdmin
    .from("platform_settings")
    .select("gemini_api_key")
    .eq("id", 1)
    .single();

  if (!settings?.gemini_api_key) {
    throw new Error("Platform Gemini API key not configured. Contact admin.");
  }

  const { decrypt } = await import("./crypto");
  return { apiKey: decrypt(settings.gemini_api_key), byok: false };
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
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("token_balance")
    .eq("id", userId)
    .single();

  const newBalance = Number(profile?.token_balance ?? 0) + amount;

  await supabaseAdmin
    .from("profiles")
    .update({ token_balance: newBalance })
    .eq("id", userId);

  await supabaseAdmin.from("token_transactions").insert({
    user_id: userId,
    amount,
    kind,
    description,
    balance_after: newBalance,
  });
}
