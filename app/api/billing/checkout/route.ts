import { createClient } from "@/lib/supabase/server";
import { createClient as createAdmin } from "@supabase/supabase-js";
import { getStripe, getOrCreateCustomer, TOKEN_PACKS, SUBSCRIPTION_PLANS } from "@/lib/stripe";
import { NextResponse } from "next/server";

const admin = createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { priceId, mode } = await request.json() as { priceId: string; mode: "payment" | "subscription" };

  if (!priceId) return NextResponse.json({ error: "priceId required" }, { status: 400 });

  // Validate priceId is one of our known prices (security)
  const validPrices = [
    ...TOKEN_PACKS.map((p) => p.priceId),
    ...SUBSCRIPTION_PLANS.map((p) => p.priceId),
  ].filter(Boolean);

  if (validPrices.length > 0 && !validPrices.includes(priceId)) {
    return NextResponse.json({ error: "Invalid priceId" }, { status: 400 });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();

  const customerId = await getOrCreateCustomer(user.id, user.email!, profile?.stripe_customer_id);

  // Persist customer ID
  if (!profile?.stripe_customer_id) {
    await admin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/dashboard/tokens?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/dashboard/tokens?canceled=1`,
    metadata: {
      supabase_user_id: user.id,
      price_id: priceId,
    },
    ...(mode === "subscription" && {
      subscription_data: { metadata: { supabase_user_id: user.id } },
    }),
  });

  return NextResponse.json({ url: session.url });
}
