import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, refundTokens, restoreFreeGeneration } from "@/lib/tokens";
import {
  generatePrompts, generateImage, imageInstructionsFor, generateListing, varyForSafety, anchorInstructions, type GeminiImagePart,
} from "@/lib/gemini";
import { ensureBucket, uploadImage, downloadImageBase64 } from "@/lib/supabase/storage";
import { resolveAngles, qualityTier, refundForRun } from "@/lib/angles";
import { category } from "@/lib/categories";
import { getAccessToken, createDriveFolder, uploadFileToDrive } from "@/lib/google-drive";
import { fetchImageAsPart } from "@/lib/safe-image-fetch";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";

export const maxDuration = 60; // Vercel Hobby cap — the worker stays well under it
const BUDGET_MS = 45_000;      // stop starting new images past this; finish + re-trigger
const MAX_PASSES = 8;          // bound retries of failed/untried slots across passes (paced runs do less per pass)

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
  rejected_slots: number[] | null; // angles the user gave up on — skip them
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

  // ADAPTIVE speed: a SMALL queue runs fast (more parallel, no pacing — like the
  // manual card flow); a BIG queue throttles to ride under the shared 429 quota.
  // gemini image = DSQ → bursts 429, but a small batch's few stragglers are easily
  // mopped up by retries, so speed wins there.
  const FAST_MAX = Math.max(1, Number(process.env.WORKER_FAST_MAX) || 12);
  const { count: pendingCount } = await supabaseAdmin
    .from("generations").select("id", { count: "exact", head: true })
    .in("status", ["queued", "processing"]);
  const fast = (pendingCount ?? 99) <= FAST_MAX;
  const lanes = fast ? 2 : Math.max(1, Number(process.env.WORKER_LANES) || 1);

  const { data: claimed } = await supabaseAdmin.rpc("claim_generation", { p_stale_seconds: 90, p_max_lanes: lanes, p_max_passes: 5 });
  const g: GenRow | undefined = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!g) return NextResponse.json({ idle: true });

  const t0 = Date.now();
  try {
    await processJob(g, t0, fast);
  } catch (e) {
    // Ownership-guarded: only mark error if WE still hold the claim (a hung
    // worker that lost its row to a stale-reclaim must not stomp the new owner).
    await supabaseAdmin.from("generations")
      .update({ status: "error", error_message: String((e as Error).message).slice(0, 200) })
      .eq("id", g.id).eq("status", "processing").eq("claimed_at", g.claimed_at);
  }

  const { data: more } = await supabaseAdmin.rpc("queue_has_work");
  if (more === true) await kickWorker(lanes); // refill up to the lane cap (extras return idle)
  return NextResponse.json({ ok: true, id: g.id });
}

async function processJob(g: GenRow, t0: number, fast: boolean): Promise<void> {
  const p: JobParams = g.params ?? {};
  const { apiKey, admin, byok, freeQuota } = await resolveApiKey(g.user_id, p.userEmail);
  const metered = !admin && !byok;
  const cat = category(p.category);
  let angles = (p.angleIds?.length) ? resolveAngles(p.angleIds, cat.angles) : [...cat.angles];
  if (angles.length === 0) angles = [...cat.angles]; // angleIds didn't match this category → use its full set
  const N = angles.length;
  const season = p.season ?? "";
  // On-model → always a real scene (studio + person reference = copied model).
  const bg = cat.onModel ? "lifestyle" : (season ? "lifestyle" : "catalog");
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

  // Pace image-generation starts to a steady rate (no bursts) so we stay under
  // the shared-quota (DSQ) throttle. Tunable via WORKER_PACE_MS.
  const PACE_MS = fast ? 0 : Math.max(0, Number(process.env.WORKER_PACE_MS) || 800);
  let nextStart = 0;
  const pace = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + PACE_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  // Per-slot failure reasons (for a diagnostic note when a job ends up partial).
  const failTags: Record<number, string> = {};
  const tagOf = (msg: string): string =>
    /SAFETY_BLOCK|PROHIBIT|RECITATION/i.test(msg) ? "блок політики" :
    /NO_IMAGE/i.test(msg) ? "без зображення" :
    /\b429\b|RESOURCE_EXHAUSTED/i.test(msg) ? "черга (429)" :
    /timeout|aborted|abort/i.test(msg) ? "таймаут" : "помилка";

  // Generate one slot. anchorIn != null → reproduce the SAME model+product from
  // that anchor image at a new angle (consistency); null → fresh shot from the
  // product reference (this IS how the anchor itself is made). Returns the b64.
  const processSlot = async (i: number, anchorIn: GeminiImagePart | null): Promise<string | null> => {
    const refsForCall = anchorIn ? [anchorIn] : refs;
    const instr = anchorIn ? anchorInstructions() : imageInstructionsFor(cat, productType, bg);
    // Anchored angles use the FULL rich per-angle prompt (varied pose/scene/crop) —
    // the anchor image supplies ONLY the model's identity. This keeps ONE model
    // across the set WITHOUT flattening every shot into the same scene.
    const base = prompts[i];
    let b64: string | null = null;
    let curPrompt = base;
    let lastErr = "";
    for (let a = 1; a <= 3; a++) {
      await pace(); // steady rate, no bursts → fewer 429 on the shared quota
      try {
        b64 = await generateImage(apiKey, curPrompt, refsForCall, tier.model, tier.location, instr);
        break;
      } catch (e) {
        const msg = String(e); lastErr = msg;
        // No image returned (policy block OR empty result) → re-sending the same
        // prompt is futile; VARY it. 429/timeout = the prompt is fine → back off.
        if (a < 3 && /SAFETY_BLOCK|NO_IMAGE|PROHIBIT|RECITATION/i.test(msg)) { curPrompt = varyForSafety(base, a - 1); continue; }
        if (a < 3) await new Promise((r) => setTimeout(r, /\b429\b|RESOURCE_EXHAUSTED/i.test(msg) ? 3500 * a : 600));
      }
    }
    if (!b64) { failTags[i] = tagOf(lastErr); return null; } // failed → retried next pass (bounded by MAX_PASSES)
    try {
      imageUrls[i] = await uploadImage(b64, `${g.user_id}/${g.id}/${i + 1}.jpg`);
      if (driveToken && driveFolderId) {
        try {
          const base = (p.sku || productType || "img").replace(/[^\wЀ-ӿ.\-]+/g, "_").slice(0, 80);
          const up = await uploadFileToDrive(driveToken, driveFolderId, `${base}_${i + 1}.jpg`, b64);
          driveUrls[i] = up.webViewLink;
        } catch { /* keep storage URL */ }
      }
    } catch { return null; /* upload failed → slot stays empty */ }
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
    return b64;
  };

  const POOL = fast ? 5 : Math.max(1, Number(process.env.WORKER_IMAGE_POOL) || 3);
  const rejectedSet = new Set(Array.isArray(g.rejected_slots) ? g.rejected_slots : []);
  const pending = Array.from({ length: N }, (_, i) => i).filter((i) => !imageUrls[i] && !rejectedSet.has(i));

  // ONE consistent model across the whole series (on-model categories): establish
  // an ANCHOR shot (the new model + product), then generate every other angle FROM
  // that anchor so it's the SAME person in all of them. Object items don't need this.
  let anchorPart: GeminiImagePart | null = null;
  if (cat.onModel && pending.length > 0) {
    const existingIdx = imageUrls.findIndex((u) => !!u); // an anchor from a prior pass?
    if (existingIdx >= 0) {
      const b = await downloadImageBase64(`${g.user_id}/${g.id}/${existingIdx + 1}.jpg`);
      if (b) anchorPart = { inline_data: { mime_type: "image/jpeg", data: b } };
    }
    if (!anchorPart) {
      // No anchor yet → make the first pending slot the anchor (fresh model), then
      // the rest follow it. Done before the pool so others can reference it.
      const aIdx = pending.shift() as number;
      const ab64 = await processSlot(aIdx, null);
      if (ab64) anchorPart = { inline_data: { mime_type: "image/jpeg", data: ab64 } };
    }
  }

  // For on-model items, NEVER generate non-anchor angles without an anchor — that
  // would produce inconsistent models. If the anchor couldn't be made this pass
  // (e.g. 429), skip the rest and let the requeue retry the anchor next pass.
  const canPool = !cat.onModel || !!anchorPart;
  if (canPool) {
    // Pool the remaining slots. POOL caps concurrent calls; a lane stops pulling
    // past the budget (in-flight ones finish, the rest go next pass).
    let cursor = 0;
    const lane = async (): Promise<void> => {
      while (cursor < pending.length) {
        if (Date.now() - t0 > BUDGET_MS) return;
        await processSlot(pending[cursor++], anchorPart); // anchorPart null for object → fresh per-angle
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, pending.length) }, lane));
  }

  // g.passes is this pass's number (claim_generation incremented it atomically).
  // Rejected slots are intentionally empty — don't count them as "remaining".
  const remaining = imageUrls.filter((u, i) => !u && !rejectedSet.has(i)).length;
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

  // Diagnostic note when some slots never produced an image — so the reason is
  // visible without server logs (counts by failure type from the final pass).
  let failNote: string | null = null;
  if (done < N) {
    const tags = Object.values(failTags);
    const counts: Record<string, number> = {};
    for (const t of tags) counts[t] = (counts[t] ?? 0) + 1;
    const summary = Object.entries(counts).map(([t, c]) => `${t}×${c}`).join(", ");
    failNote = `${N - done}/${N} не вийшло${summary ? ` (${summary})` : ""}`;
  }

  // Atomically take ownership of finalization. If 0 rows match, another worker
  // already finalized this job (hang/stale-reclaim path) → we must NOT run the
  // token/counter side-effects again (double refund / double increment).
  const { data: finalized } = await supabaseAdmin.from("generations").update({
    status: done > 0 ? "done" : "error",
    ...(listing ? { listing } : {}),
    ...(done === 0 ? { error_message: failNote ?? "all_images_failed" } : (failNote ? { error_message: failNote } : {})),
  }).eq("id", g.id).eq("status", "processing").eq("claimed_at", g.claimed_at).select("id");
  if (!finalized || finalized.length === 0) return; // lost the claim — no side-effects

  if (metered && !freeQuota) {
    const refund = refundForRun(N, done, tier.tokenMultiplier);
    if (refund > 0) await refundTokens(g.user_id, g.id, refund, `Повернення за ${N - done} невдалих`).catch(() => {});
  }
  if (freeQuota && done === 0) await restoreFreeGeneration(g.user_id);
  if (!freeQuota && !admin && done > 0) await supabaseAdmin.rpc("increment_generations_used", { p_user_id: g.user_id });
}
