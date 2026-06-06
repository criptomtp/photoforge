import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, refundTokens, restoreFreeGeneration } from "@/lib/tokens";
import {
  generatePrompts, generateImage, imageInstructionsFor, generateListing, varyForSafety, type GeminiImagePart,
} from "@/lib/gemini";
import { ensureBucket, uploadImage } from "@/lib/supabase/storage";
import { resolveAngles, qualityTier, refundForRun } from "@/lib/angles";
import { category } from "@/lib/categories";
import { getAccessToken, createDriveFolder, uploadFileToDrive } from "@/lib/google-drive";
import { fetchImageAsPart } from "@/lib/safe-image-fetch";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";

export const maxDuration = 60; // Vercel Hobby cap — the worker stays well under it
const BUDGET_MS = 45_000;      // stop starting new images past this; finish + re-trigger
const MAX_PASSES = 5;          // bound retries of failed/untried slots across passes

interface JobParams {
  userEmail?: string; category?: string; productType?: string; name?: string;
  brand?: string; color?: string; size?: string; gender?: string; season?: string;
  composition?: string; country?: string; sku?: string;
  photoUrls?: string[]; angleIds?: string[]; quality?: string;
  mode?: "images" | "both"; drive?: boolean; driveParentId?: string;
}
interface GenRow {
  id: string; user_id: string; params: JobParams | null;
  prompts: string[] | null; image_urls: string[] | null; drive_urls: string[] | null;
  drive_folder_id: string | null; listing: unknown;
  claimed_at: string | null; // ownership token — claim_generation sets it to now()
  passes: number | null;     // how many worker passes this job has had
}

function urlsOfLength(arr: unknown, n: number): string[] {
  const a = Array.isArray(arr) ? (arr as string[]) : [];
  const out = new Array<string>(n).fill("");
  for (let i = 0; i < n; i++) out[i] = typeof a[i] === "string" ? a[i] : "";
  return out;
}

export async function POST(request: Request) {
  if (request.headers.get("x-worker-secret") !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Finalize any orphaned jobs (killed mid-pass at the pass cap) so a batch can
  // never freeze. Cheap; runs every invocation, even when we end up idle.
  // 120s > the 60s Vercel hard-kill, so reaping can never touch a live worker.
  try { await supabaseAdmin.rpc("reap_orphans", { p_stale_seconds: 120, p_max_passes: 5 }); } catch { /* best effort */ }

  // Lanes (concurrent products) tunable via env — raise after a Vertex quota bump.
  const lanes = Math.max(1, Number(process.env.WORKER_LANES) || 2);
  const { data: claimed } = await supabaseAdmin.rpc("claim_generation", { p_stale_seconds: 90, p_max_lanes: lanes, p_max_passes: 5 });
  const g: GenRow | undefined = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!g) return NextResponse.json({ idle: true });

  const t0 = Date.now();
  try {
    await processJob(g, t0);
  } catch (e) {
    // Ownership-guarded: only mark error if WE still hold the claim (a hung
    // worker that lost its row to a stale-reclaim must not stomp the new owner).
    await supabaseAdmin.from("generations")
      .update({ status: "error", error_message: String((e as Error).message).slice(0, 200) })
      .eq("id", g.id).eq("status", "processing").eq("claimed_at", g.claimed_at);
  }

  const { data: more } = await supabaseAdmin.rpc("queue_has_work");
  if (more === true) await kickWorker(2); // refill up to the lane cap (extras return idle)
  return NextResponse.json({ ok: true, id: g.id });
}

async function processJob(g: GenRow, t0: number): Promise<void> {
  const p: JobParams = g.params ?? {};
  const { apiKey, admin, byok, freeQuota } = await resolveApiKey(g.user_id, p.userEmail);
  const metered = !admin && !byok;
  const cat = category(p.category);
  const angles = (p.angleIds?.length) ? resolveAngles(p.angleIds, cat.angles) : [...cat.angles];
  const N = angles.length;
  const season = p.season ?? "";
  const bg = season ? "lifestyle" : "catalog";
  const productType = (p.productType || p.name || "").trim();
  const tier = qualityTier(p.quality);

  const refs = (await Promise.all((p.photoUrls ?? []).slice(0, 3).map(fetchImageAsPart)))
    .filter((x): x is GeminiImagePart => !!x);
  if (refs.length === 0) {
    if (metered) await refundTokens(g.user_id, g.id, refundForRun(N, 0, tier.tokenMultiplier), "Повернення: немає фото").catch(() => {});
    if (freeQuota) await restoreFreeGeneration(g.user_id);
    await supabaseAdmin.from("generations").update({ status: "error", error_message: "no_reference_photos" }).eq("id", g.id);
    return;
  }

  await ensureBucket();

  let prompts = Array.isArray(g.prompts) ? g.prompts : [];
  if (prompts.length < N) {
    prompts = await generatePrompts(apiKey, cat, productType, season, p.gender ?? "", refs, angles);
    await supabaseAdmin.from("generations").update({ prompts }).eq("id", g.id);
  }

  const imageUrls = urlsOfLength(g.image_urls, N);
  const driveUrls = urlsOfLength(g.drive_urls, N);

  let driveFolderId = g.drive_folder_id;
  let driveToken: string | null = null;
  if (p.drive) {
    driveToken = await getAccessToken(g.user_id).catch(() => null);
    if (driveToken && !driveFolderId) {
      try {
        const f = await createDriveFolder(driveToken, (p.sku || productType || "PhotoForge").slice(0, 80), p.driveParentId || undefined);
        driveFolderId = f.id;
        await supabaseAdmin.from("generations").update({ drive_folder_id: driveFolderId }).eq("id", g.id);
      } catch { /* fall back to storage */ }
    }
  }

  // Generate one slot: gen (3 attempts, 429-aware) → upload → Drive → atomic
  // per-slot DB write (with a full-array fallback so a paid image is never lost).
  const processSlot = async (i: number): Promise<void> => {
    let b64: string | null = null;
    let curPrompt = prompts[i];
    for (let a = 1; a <= 3; a++) {
      try {
        b64 = await generateImage(apiKey, curPrompt, refs, tier.model, tier.location, imageInstructionsFor(cat, productType, bg));
        break;
      } catch (e) {
        const msg = String(e);
        // Policy/safety block → re-sending the same prompt is futile; VARY it for
        // the next attempt. 429 = free (Vertex rejects pre-generation) → back off.
        if (a < 3 && /SAFETY_BLOCK/.test(msg)) { curPrompt = varyForSafety(prompts[i], a - 1); continue; }
        if (a < 3) await new Promise((r) => setTimeout(r, /\b429\b|RESOURCE_EXHAUSTED/i.test(msg) ? 2500 * a : 600));
      }
    }
    if (!b64) return; // failed this pass → retried next pass (bounded by MAX_PASSES)
    try {
      imageUrls[i] = await uploadImage(b64, `${g.user_id}/${g.id}/${i + 1}.jpg`);
      if (driveToken && driveFolderId) {
        try {
          const base = (p.sku || productType || "img").replace(/[^\wЀ-ӿ.\-]+/g, "_").slice(0, 80);
          const up = await uploadFileToDrive(driveToken, driveFolderId, `${base}_${i + 1}.jpg`, b64);
          driveUrls[i] = up.webViewLink;
        } catch { /* keep storage URL */ }
      }
    } catch { return; /* upload failed → slot stays empty */ }
    // Atomic per-slot write (FOR UPDATE serializes parallel writes on this row).
    let saved = false;
    for (let s = 0; s < 2 && !saved; s++) {
      try {
        await supabaseAdmin.rpc("qa_set_slot", {
          p_gen_id: g.id, p_index: i, p_image_url: imageUrls[i], p_drive_url: driveUrls[i] || "",
        });
        saved = true;
      } catch { if (s === 0) await new Promise((r) => setTimeout(r, 400)); }
    }
    if (!saved) {
      try {
        await supabaseAdmin.from("generations")
          .update({ image_urls: imageUrls, drive_urls: driveUrls, images_generated: imageUrls.filter(Boolean).length })
          .eq("id", g.id).eq("claimed_at", g.claimed_at);
      } catch { imageUrls[i] = ""; driveUrls[i] = ""; } // truly unpersistable → count as failed
    }
  };

  // Generate pending slots IN PARALLEL (a pool). Sequential generation was the
  // main slowness. Safe: one worker per job (lane cap + claim) + per-slot atomic
  // writes. POOL caps concurrent Vertex calls per worker. A lane stops pulling new
  // slots once the budget is spent; in-flight ones finish, the rest go next pass.
  const POOL = Math.max(1, Number(process.env.WORKER_IMAGE_POOL) || 5);
  const pending = Array.from({ length: N }, (_, i) => i).filter((i) => !imageUrls[i]);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < pending.length) {
      if (Date.now() - t0 > BUDGET_MS) return;
      await processSlot(pending[cursor++]); // cursor read+increment is atomic in JS
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, pending.length) }, lane));

  // g.passes is this pass's number (claim_generation incremented it atomically).
  const remaining = imageUrls.filter((u) => !u).length;
  if (remaining > 0 && (g.passes ?? 1) < MAX_PASSES) {
    // Slots still to do — either untried (budget ran out) or failed and worth a
    // retry (a 429 is usually transient and FREE). Hand off via the queue for a
    // fresh budget + lower quota pressure. Ownership-guarded so a stale-reclaimed
    // worker can't requeue the new owner's live job. MAX_PASSES (enforced at claim
    // time) bounds a persistently-failing slot so it can't loop forever.
    await supabaseAdmin.from("generations")
      .update({ status: "queued", claimed_at: null })
      .eq("id", g.id).eq("status", "processing").eq("claimed_at", g.claimed_at);
    return;
  }

  // Finalize: every slot was attempted this pass.
  const done = imageUrls.filter(Boolean).length;
  let listing = g.listing ?? null;
  if (!listing && p.mode === "both") {
    try {
      listing = await generateListing(apiKey, {
        name: p.name, productType, brand: p.brand, color: p.color, size: p.size,
        gender: p.gender, season, composition: p.composition, country: p.country, sku: p.sku,
      }, refs[0]);
    } catch { /* non-fatal */ }
  }

  // Atomically take ownership of finalization. If 0 rows match, another worker
  // already finalized this job (hang/stale-reclaim path) → we must NOT run the
  // token/counter side-effects again (double refund / double increment).
  const { data: finalized } = await supabaseAdmin.from("generations").update({
    status: done > 0 ? "done" : "error",
    ...(listing ? { listing } : {}),
    ...(done === 0 ? { error_message: "all_images_failed" } : {}),
  }).eq("id", g.id).eq("status", "processing").eq("claimed_at", g.claimed_at).select("id");
  if (!finalized || finalized.length === 0) return; // lost the claim — no side-effects

  if (metered && !freeQuota) {
    const refund = refundForRun(N, done, tier.tokenMultiplier);
    if (refund > 0) await refundTokens(g.user_id, g.id, refund, `Повернення за ${N - done} невдалих`).catch(() => {});
  }
  if (freeQuota && done === 0) await restoreFreeGeneration(g.user_id);
  if (!freeQuota && !admin && done > 0) await supabaseAdmin.rpc("increment_generations_used", { p_user_id: g.user_id });
}
