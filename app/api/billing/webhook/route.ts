import { getStripe, TOKEN_PACKS, SUBSCRIPTION_PLANS, type PlanId } from "@/lib/stripe";
import { creditTokens } from "@/lib/tokens";
import { supabaseAdmin as admin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

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

  // ── Idempotency: process each Stripe event at most once ──────────────────
  // Stripe delivers at-least-once and lets you re-send events from the Dashboard;
  // without this guard a duplicate would credit tokens again. Requires the
  // stripe_events table (migration 20260529000006).
  {
    const { error: dupErr } = await admin
      .from("stripe_events")
      .insert({ id: event.id, type: event.type });
    if (dupErr) {
      // 23505 = unique_violation → already processed: ack and stop.
      if ((dupErr as { code?: string }).code === "23505") {
        return NextResponse.json({ received: true, duplicate: true });
      }
      // Any other error: do NOT process; return 500 so Stripe retries later.
      console.error("stripe_events insert failed:", dupErr);
      return NextResponse.json({ error: "ledger unavailable" }, { status: 500 });
    }
  }

  try {
    switch (event.type) {
    // ── One-time token pack purchase ─────────────────────────────────────
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "payment") break;
      // Credit only when the money is actually captured (async methods may not be).
      if (session.payment_status !== "paid") break;

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
      const invoice = event.data.object as Stripe.Invoice & {
        subscription?: string | null;
        billing_reason?: string | null;
      };
      if (!invoice.subscription) break;
      // Grant monthly tokens only on initial activation and renewals — not on
      // mid-cycle proration updates. (Idempotency above blocks duplicate deliveries.)
      if (
        invoice.billing_reason &&
        !["subscription_create", "subscription_cycle"].includes(invoice.billing_reason)
      ) {
        break;
      }

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
        generations_used: 0,
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

    // ── Refund / chargeback: claw back purchased tokens (clamped at 0) ────
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const pi = typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id;
      if (!pi) break;

      const sessions = await getStripe().checkout.sessions.list({ payment_intent: pi, limit: 1 });
      const refundSession = sessions.data[0];
      if (!refundSession || refundSession.mode !== "payment") {
        console.warn("charge.refunded: no matching payment checkout session for PI", pi);
        break;
      }

      const userId = refundSession.metadata?.supabase_user_id
        ?? await getUserIdByCustomer(charge.customer as string);
      if (!userId) break;

      const pack = TOKEN_PACKS.find((p) => p.priceId === refundSession.metadata?.price_id);
      if (!pack) break;

      // Policy: remove the purchased tokens without driving the balance below 0.
      // Tokens already spent (real AI cost incurred) are not recoverable.
      await admin.rpc("clamp_debit_tokens", {
        p_user_id: userId,
        p_amount: pack.tokens,
        p_kind: "refund",
        p_description: `Повернення коштів: ${pack.label} (${pack.tokens} токенів)`,
      });
      break;
    }

    // ── Failed subscription payment: log only; Stripe dunning eventually fires
    //    customer.subscription.deleted, which performs the downgrade. ─────────
    case "invoice.payment_failed": {
      const failedInvoice = event.data.object as Stripe.Invoice & { subscription?: string | null };
      console.warn("invoice.payment_failed (subscription:", failedInvoice.subscription, ")");
      break;
    }
    }
  } catch (processErr) {
    // Processing failed AFTER the event was marked seen — remove the marker so
    // Stripe's retry reprocesses it instead of being skipped as a duplicate.
    try { await admin.from("stripe_events").delete().eq("id", event.id); } catch { /* best effort */ }
    console.error("Webhook processing failed:", processErr);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
