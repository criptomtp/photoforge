import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, creditTokens, restoreFreeGeneration } from "@/lib/tokens";
import { resolveAngles, refundForRun, qualityTier } from "@/lib/angles";
import { category } from "@/lib/categories";
import { NextResponse } from "next/server";

export const maxDuration = 30;

interface RowParams { angleIds?: string[]; category?: string; quality?: string }

// Cancel a running/queued batch: mark its not-yet-finished rows as cancelled so
// workers stop claiming them. Refunds metered users for the un-generated images.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Grab the rows we're about to cancel (for refund math), scoped to this user.
  const { data: rows } = await supabaseAdmin
    .from("generations")
    .select("id, params, images_generated")
    .eq("batch_id", batchId).eq("user_id", user.id)
    .in("status", ["queued", "processing"]);
  const targets = rows ?? [];
  if (targets.length === 0) return NextResponse.json({ ok: true, cancelled: 0 });

  // Stop them.
  await supabaseAdmin.from("generations")
    .update({ status: "error", error_message: "cancelled_by_user", claimed_at: null })
    .eq("batch_id", batchId).eq("user_id", user.id)
    .in("status", ["queued", "processing"]);

  // Refund the un-generated portion for metered users (admin/BYOK = free).
  try {
    const { admin, byok, freeQuota } = await resolveApiKey(user.id, user.email);
    if (!admin && !byok && !freeQuota) {
      let total = 0;
      for (const r of targets) {
        const p: RowParams = (r.params as RowParams) ?? {};
        const cat = category(p.category);
        const N = (p.angleIds?.length) ? (resolveAngles(p.angleIds, cat.angles).length || cat.angles.length) : cat.angles.length;
        const tier = qualityTier(p.quality);
        total += refundForRun(N, (r.images_generated as number) ?? 0, tier.tokenMultiplier);
      }
      if (total > 0) await creditTokens(user.id, total, "refund", `Скасування партії: ${targets.length} товарів`).catch(() => {});
    } else if (freeQuota) {
      for (const _ of targets) await restoreFreeGeneration(user.id);
    }
  } catch { /* refund best-effort */ }

  return NextResponse.json({ ok: true, cancelled: targets.length });
}
