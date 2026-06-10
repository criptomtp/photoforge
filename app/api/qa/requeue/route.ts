import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, chargeTokens } from "@/lib/tokens";
import { resolveAngles, qualityTier, TOKEN_COSTS } from "@/lib/angles";
import { category } from "@/lib/categories";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";

export const maxDuration = 20;

interface P { category?: string; angleIds?: string[]; quality?: string }

// Re-queue a SETTLED generation so the worker fills its still-empty slots with its
// full multi-pass persistence (pacing + retries across many invocations) — far more
// 429-resilient than the one-shot synchronous QA regen.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { generationId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!body.generationId) return NextResponse.json({ error: "bad params" }, { status: 400 });

  const { data: g } = await supabaseAdmin
    .from("generations")
    .select("id, user_id, status, params, image_urls, rejected_slots")
    .eq("id", body.generationId).single();
  if (!g || g.user_id !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });
  // In flight / draft → nothing to requeue here (drafts use generate-one).
  if (["queued", "processing", "draft"].includes(g.status))
    return NextResponse.json({ ok: true, already: true });

  const p: P = (g.params as P) ?? {};
  const cat = category(p.category);
  const N = (p.angleIds?.length) ? (resolveAngles(p.angleIds, cat.angles).length || cat.angles.length) : cat.angles.length;
  const imageUrls = Array.isArray(g.image_urls) ? (g.image_urls as string[]) : [];
  const rejected = new Set(Array.isArray(g.rejected_slots) ? (g.rejected_slots as number[]) : []);
  let doneCount = 0, fillable = 0;
  for (let i = 0; i < N; i++) {
    if (imageUrls[i]) doneCount++;
    else if (!rejected.has(i)) fillable++;
  }
  if (fillable === 0) return NextResponse.json({ ok: true, queued: 0 }); // nothing the worker can fill

  // Funds/flags check (read-only) BEFORE flipping, so an underfunded metered user
  // is rejected without ever queueing.
  let ctx;
  try { ctx = await resolveApiKey(user.id, user.email); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }
  const { admin, byok, freeQuota } = ctx;

  // Flip done/error → queued ATOMICALLY first. A concurrent double-click loses the
  // flip (0 rows) and returns without charging — so only one request ever charges.
  const prevStatus = g.status;
  const { data: flipped } = await supabaseAdmin.from("generations")
    .update({ status: "queued", claimed_at: null, passes: 0, error_message: null })
    .eq("id", g.id).eq("user_id", user.id).in("status", ["done", "error"]).select("id");
  if (!flipped || flipped.length === 0) return NextResponse.json({ ok: true, already: true });

  // We own the flip → charge now (metered only). Charge for ALL empty slots
  // (N - doneCount, INCLUDING rejected) to exactly reverse the original run's
  // finalize refund, so the worker's next refundForRun(N, done) — which uses raw N —
  // nets to the images that actually exist. Admin/BYOK free; free-quota already
  // consumed its slot in the original run, so a retry of failed slots is free.
  // Revert the flip if the charge is rejected (don't generate for an unpaid user).
  if (!admin && !byok && !freeQuota) {
    const tier = qualityTier(p.quality);
    const cost = TOKEN_COSTS.image_gen * tier.tokenMultiplier * (N - doneCount);
    try { await chargeTokens(user.id, cost, "generation", `Догенерація: ${fillable} фото`); }
    catch (e) {
      await supabaseAdmin.from("generations").update({ status: prevStatus }).eq("id", g.id).eq("status", "queued");
      return NextResponse.json({ error: (e as Error).message }, { status: 402 });
    }
  }

  await kickWorker(2);
  return NextResponse.json({ ok: true, queued: fillable });
}
