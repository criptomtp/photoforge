import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

// ── Product config ──────────────────────────────────────────────────────────
// Token packs (one-time purchases)
export const TOKEN_PACKS = [
  {
    id: "pack_10",
    label: "Starter Pack",
    tokens: 10,
    usd: 5,
    priceId: process.env.STRIPE_PRICE_TOKENS_10 ?? "",
    generations: 2,
    popular: false,
  },
  {
    id: "pack_50",
    label: "Growth Pack",
    tokens: 50,
    usd: 20,
    priceId: process.env.STRIPE_PRICE_TOKENS_50 ?? "",
    generations: 12,
    popular: true,
  },
  {
    id: "pack_200",
    label: "Pro Pack",
    tokens: 200,
    usd: 70,
    priceId: process.env.STRIPE_PRICE_TOKENS_200 ?? "",
    generations: 48,
    popular: false,
  },
] as const;

// Subscription plans
export const SUBSCRIPTION_PLANS = [
  {
    id: "starter",
    label: "Starter",
    usd: 29,
    priceId: process.env.STRIPE_PRICE_STARTER ?? "",
    tokensPerMonth: 100,
    generationsPerMonth: 24,
    features: ["100 генерацій/міс", "Google Drive", "Google Sheets", "Без водяного знаку"],
  },
  {
    id: "pro",
    label: "Pro",
    usd: 79,
    priceId: process.env.STRIPE_PRICE_PRO ?? "",
    tokensPerMonth: 500,
    generationsPerMonth: 121,
    features: ["500 генерацій/міс", "Excel + Sheets", "Google Drive + ZIP", "Пріоритетна черга", "API доступ"],
  },
] as const;

export type PlanId = "free" | "starter" | "pro" | "enterprise";

// ── Create Stripe customer for user ────────────────────────────────────────
export async function getOrCreateCustomer(
  userId: string,
  email: string,
  existingCustomerId?: string | null
): Promise<string> {
  if (existingCustomerId) return existingCustomerId;

  const customer = await getStripe().customers.create({
    email,
    metadata: { supabase_user_id: userId },
  });

  return customer.id;
}
