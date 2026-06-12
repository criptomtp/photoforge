import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, reserveTokens } from "@/lib/tokens";
import { resolveAngles, qualityTier, TOKEN_COSTS } from "@/lib/angles";
import { category } from "@/lib/categories";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";

export const maxDuration = 20;

interface P { angleIds?: string[]; category?: string; quality?: string }

// Trigger ONE draft product (step-by-step card mode): flip draft→queued, reserve
// tokens, and kick the worker — so only this product generates, on demand.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { generationId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!body.generationId) return NextResponse.json({ error: "bad params" }, { status: 400 });

  const { data: g } = await supabaseAdmin
    .from("generations")
    .select("id, user_id, status, params")
    .eq("id", body.generationId).eq("batch_id", batchId).single();
  if (!g || g.user_id !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (g.status !== "draft") return NextResponse.json({ ok: true, already: true }); // already triggered/done

  // Atomically claim the draft → queued (guards against double-clicks).
  const { data: flipped } = await supabaseAdmin.from("generations")
    .update({ status: "queued" }).eq("id", g.id).eq("status", "draft").select("id");
  if (!flipped || flipped.length === 0) return NextResponse.json({ ok: true, already: true });

  // We own the flip → reserve tokens (metered). Revert to draft on failure.
  const p: P = (g.params as P) ?? {};
  const cat = category(p.category);
  const N = (p.angleIds?.length) ? (resolveAngles(p.angleIds, cat.angles).length || cat.angles.length) : cat.angles.length;
  const tier = qualityTier(p.quality);
  try {
    const { admin, byok, freeQuota } = await resolveApiKey(user.id, user.email);
    // Refresh the reconcile metadata to what we're ACTUALLY doing now (the kind
    // stored at enqueue could be stale if the user's quota/balance changed).
    const billingKind = (admin || byok) ? "none" : (freeQuota ? "free" : "metered");
    await supabaseAdmin.from("generations")
      .update({ billing_kind: billingKind, refund_unit: TOKEN_COSTS.image_gen * tier.tokenMultiplier, images_target: N })
      .eq("id", g.id);
    if (!admin && !byok && !freeQuota) {
      try { await reserveTokens(user.id, g.id, N, tier.tokenMultiplier); }
      catch (e) {
        await supabaseAdmin.from("generations").update({ status: "draft" }).eq("id", g.id);
        return NextResponse.json({ error: (e as Error).message }, { status: 402 });
      }
    } else if (freeQuota) {
      const { data: ok } = await supabaseAdmin.rpc("try_consume_free_generation", { p_user_id: user.id });
      if (ok !== true) {
        await supabaseAdmin.from("generations").update({ status: "draft" }).eq("id", g.id);
        return NextResponse.json({ error: "free_quota_exhausted" }, { status: 402 });
      }
    }
  } catch { /* resolveApiKey issue — let it proceed (admin/owner path) */ }

  await kickWorker(2);
  return NextResponse.json({ ok: true });
}
