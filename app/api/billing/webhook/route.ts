import { getStripe, TOKEN_PACKS, SUBSCRIPTION_PLANS, type PlanId } from "@/lib/stripe";
import { creditTokens } from "@/lib/tokens";
import { createClient as createAdmin } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

const admin = createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function getUserIdByCustomer(customerId: string): Promise<string | null> {
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  return data?.id ?? null;
}

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig!, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("Webhook signature failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    // ── One-time token pack purchase ─────────────────────────────────────
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment") break;

      const userId = session.metadata?.supabase_user_id
        ?? await getUserIdByCustomer(session.customer as string);
      if (!userId) break;

      const priceId = session.metadata?.price_id;
      const pack = TOKEN_PACKS.find((p) => p.priceId === priceId);
      if (!pack) break;

      await creditTokens(userId, pack.tokens, "purchase", `Покупка: ${pack.label} (${pack.tokens} токенів)`);
      break;
    }

    // ── Subscription activated / renewed ────────────────────────────────
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string | null };
      if (!invoice.subscription) break;

      const sub = await getStripe().subscriptions.retrieve(invoice.subscription);
      const userId = sub.metadata?.supabase_user_id
        ?? await getUserIdByCustomer(sub.customer as string);
      if (!userId) break;

      const priceId = sub.items.data[0]?.price.id;
      const plan = SUBSCRIPTION_PLANS.find((p) => p.priceId === priceId);
      if (!plan) break;

      // Credit monthly tokens + update plan
      await admin.from("profiles").update({
        plan: plan.id as PlanId,
        generations_limit: plan.generationsPerMonth,
        generations_used: 0, // reset monthly counter
        stripe_subscription_id: sub.id,
      }).eq("id", userId);

      await creditTokens(
        userId,
        plan.tokensPerMonth,
        "bonus",
        `${plan.label} план — місячні токени`
      );
      break;
    }

    // ── Subscription cancelled ───────────────────────────────────────────
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.supabase_user_id
        ?? await getUserIdByCustomer(sub.customer as string);
      if (!userId) break;

      await admin.from("profiles").update({
        plan: "free",
        generations_limit: 5,
        stripe_subscription_id: null,
      }).eq("id", userId);
      break;
    }

    // ── Subscription plan change ─────────────────────────────────────────
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.supabase_user_id
        ?? await getUserIdByCustomer(sub.customer as string);
      if (!userId) break;

      const priceId = sub.items.data[0]?.price.id;
      const plan = SUBSCRIPTION_PLANS.find((p) => p.priceId === priceId);
      if (!plan) break;

      await admin.from("profiles").update({
        plan: plan.id as PlanId,
        generations_limit: plan.generationsPerMonth,
      }).eq("id", userId);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
