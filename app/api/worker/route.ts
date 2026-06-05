import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, refundTokens, restoreFreeGeneration } from "@/lib/tokens";
import {
  generatePrompts, generateImage, imageInstructionsFor, generateListing, type GeminiImagePart,
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

  const { data: claimed } = await supabaseAdmin.rpc("claim_generation", { p_stale_seconds: 90, p_max_lanes: 3, p_max_passes: 5 });
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
  if (more === true) await kickWorker(3); // refill up to the lane cap (extras return idle)
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

  for (let i = 0; i < N; i++) {
    if (imageUrls[i]) continue;
    if (Date.now() - t0 > BUDGET_MS) break; // out of time → remaining slots go to next pass
    let b64: string | null = null;
    for (let a = 1; a <= 3; a++) {
      try {
        b64 = await generateImage(apiKey, prompts[i], refs, tier.model, tier.location, imageInstructionsFor(cat, productType, bg));
        break;
      } catch (e) {
        // 429 = free (Vertex rejects before generating) — back off and retry.
        const is429 = /\b429\b|RESOURCE_EXHAUSTED/i.test(String(e));
        if (a < 3) await new Promise((r) => setTimeout(r, is429 ? 2500 * a : 600));
      }
    }
    if (b64) {
      try {
        imageUrls[i] = await uploadImage(b64, `${g.user_id}/${g.id}/${i + 1}.jpg`);
        if (driveToken && driveFolderId) {
          try {
            const base = (p.sku || productType || "img").replace(/[^\wЀ-ӿ.\-]+/g, "_").slice(0, 80);
            const up = await uploadFileToDrive(driveToken, driveFolderId, `${base}_${i + 1}.jpg`, b64);
            driveUrls[i] = up.webViewLink;
          } catch { /* keep storage URL */ }
        }
      } catch { /* slot empty */ }
    }
    // Atomic per-slot write (FOR UPDATE + recomputes images_generated). A full-
    // array overwrite here was the "floating count" bug: a second worker on the
    // same job would clobber slots it didn't know about. A throw here must NOT
    // abort the job (that would skip the refund) — retry once, else drop the slot.
    if (imageUrls[i]) {
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
        // Fallback: persist the whole local array (safe — lane cap + claim mean
        // we're the only worker on this row) so a generated+uploaded image is NOT
        // lost and re-generated (paid) next pass.
        try {
          await supabaseAdmin.from("generations")
            .update({ image_urls: imageUrls, drive_urls: driveUrls, images_generated: imageUrls.filter(Boolean).length })
            .eq("id", g.id).eq("claimed_at", g.claimed_at);
        } catch { imageUrls[i] = ""; driveUrls[i] = ""; } // truly unpersistable → count as failed
      }
    }
  }

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
