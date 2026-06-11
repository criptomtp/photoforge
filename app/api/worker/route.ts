import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, refundTokens, restoreFreeGeneration } from "@/lib/tokens";
import {
  generatePrompts, generateImage, imageInstructionsFor, anchorInstructions, generateListing, varyForSafety, type GeminiImagePart,
} from "@/lib/gemini";
import { ensureBucket, uploadImage, downloadImageBase64 } from "@/lib/supabase/storage";
import { resolveAngles, qualityTier, refundForRun } from "@/lib/angles";
import { category, isPersonAngle, anchorAngleIndex } from "@/lib/categories";
import { getAccessToken, createDriveFolder, uploadFileToDrive } from "@/lib/google-drive";
import { fetchImageAsPart } from "@/lib/safe-image-fetch";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

// Constant-time secret comparison (avoids leaking the secret length / prefix via
// response timing). Returns false on any missing/!= -length input.
function secretOk(provided: string | null): boolean {
  const expected = process.env.WORKER_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const maxDuration = 60; // Vercel Hobby cap — the worker stays well under it
const BUDGET_MS = 45_000;      // stop starting new images past this; finish + re-trigger
// Bound re-queue passes per product. FIFO + a HIGH value = "hammer the oldest
// product until all its slots are done, then move on" — for an overnight Vertex
// run under DSQ where each pass only lands 1-2 images. Tunable via env.
const MAX_PASSES = Math.max(1, Number(process.env.WORKER_MAX_PASSES) || 8);

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
  if (!secretOk(request.headers.get("x-worker-secret"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Finalize any orphaned jobs (killed mid-pass at the pass cap) so a batch can
  // never freeze. Cheap; runs every invocation, even when we end up idle.
  // 120s > the 60s Vercel hard-kill, so reaping can never touch a live worker.
  try { await supabaseAdmin.rpc("reap_orphans", { p_stale_seconds: 120, p_max_passes: MAX_PASSES }); } catch { /* best effort */ }

  // ADAPTIVE speed: a SMALL queue runs fast (more parallel, no pacing — like the
  // manual card flow); a BIG queue throttles to ride under the shared 429 quota.
  // gemini image = DSQ → bursts 429, but a small batch's few stragglers are easily
  // mopped up by retries, so speed wins there.
  const FAST_MAX = Math.max(1, Number(process.env.WORKER_FAST_MAX) || 12);
  const { count: pendingCount } = await supabaseAdmin
    .from("generations").select("id", { count: "exact", head: true })
    .in("status", ["queued", "processing"]);
  const fast = (pendingCount ?? 99) <= FAST_MAX;
  // Throttling a big queue does NOT avoid 429 (DSQ rejects regardless) — it only
  // slows successes. Since failed 429s are free + retried, flood MORE concurrent
  // requests to maximize successes/minute. Big-queue defaults are now aggressive
  // (3 products in parallel); all tunable via env.
  const lanes = fast ? 2 : Math.max(1, Number(process.env.WORKER_LANES) || 3);

  const { data: claimed } = await supabaseAdmin.rpc("claim_generation", { p_stale_seconds: 90, p_max_lanes: lanes, p_max_passes: MAX_PASSES });
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
  // Honor the user's choice: studio → clean catalog bg; any/seasonal → real scene.
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

  // Split prompts ↔ images across passes. Prompt generation (gemini-2.5-pro) eats
  // ~30-45s of the 60s function, so attempting images in the SAME pass blows the
  // Vercel cap → the worker is killed mid-image, the job is orphaned, and recovers
  // only via the slow 120s reap (≈2 min lost per product). If little budget remains,
  // hand the IMAGE work to a FRESH pass: prompts are saved, so the next pass jumps
  // straight to images with a full budget. (When prompts were already cached, almost
  // no time has elapsed → we fall through and generate images now, as before.)
  // Ownership-guarded so a stale-reclaimed worker can't requeue the new owner's job.
  if (Date.now() - t0 > BUDGET_MS - 10_000) {
    await supabaseAdmin.from("generations")
      .update({ status: "queued", claimed_at: null })
      .eq("id", g.id).eq("status", "processing").eq("claimed_at", g.claimed_at);
    return;
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
  const PACE_MS = fast ? 0 : Math.max(0, Number(process.env.WORKER_PACE_MS) || 150);
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

  // ── Identity anchor (env-gated IDENTITY_ANCHOR, on-model categories only) ───
  // The SAME model must appear on every PERSON angle. We generate ONE reliable
  // full-identity shot first, then feed it back as an IDENTITY-ONLY reference
  // (alongside the product refs) to the other person angles — so Nano Banana keeps
  // the same face/hair/body while pose+scene come from each rich per-angle prompt.
  // Product-only angles (detail/macro/flat shots) NEVER receive the person image,
  // so a figure can't bleed into a close-up (the old "деталь = walking girl" bug).
  // ZERO extra image calls: the anchor is a shot we generate anyway (or re-download
  // from storage on a later pass — a cheap fetch, not a Gemini call).
  const rejectedSet = new Set(Array.isArray(g.rejected_slots) ? g.rejected_slots : []);
  const anchorOn = process.env.IDENTITY_ANCHOR === "1" && cat.onModel;
  let anchorIdx = anchorOn ? anchorAngleIndex(cat.id, angles) : -1;
  if (anchorIdx >= 0 && rejectedSet.has(anchorIdx)) anchorIdx = -1; // user gave up on it → no anchor
  let anchorPart: GeminiImagePart | null = null;
  const anchorInstr = anchorOn ? anchorInstructions(productType) : "";
  const mimeOfB64 = (b64: string) => (b64.startsWith("/9j/") ? "image/jpeg" : "image/png");
  // A person angle (not the anchor itself) that needs the identity reference.
  const needsAnchor = (i: number) =>
    anchorIdx >= 0 && i !== anchorIdx && isPersonAngle(cat.id, angles[i].id);

  // Generate one slot. A PERSON angle (other than the anchor itself) uses the
  // identity anchor + product refs + role-split instructions → the same model in a
  // DYNAMIC shot. The anchor slot and all product-only angles keep the independent
  // product-only flow (each a distinct shot; the macro stays a true macro).
  // Returns the generated base64 so the anchor pre-step can capture its bytes.
  const processSlot = async (i: number): Promise<string | null> => {
    const useAnchor = !!anchorPart && needsAnchor(i);
    // Reference images fed to Nano Banana:
    // - anchor flow: identity (image 1) + ONE product ref.
    // - non-anchor ON-MODEL (Make mode): exactly ONE product ref. Product photos
    //   usually show the SELLER's original model; feeding several (we fetch up to
    //   3) gives the model multiple competing faces and it drifts / copies the
    //   seller. Make fed exactly one and stayed consistent via the word-for-word
    //   character sheet in the prompt — we match that.
    // - object (no model): all refs (no competing person → more fidelity is fine).
    const callRefs = useAnchor
      ? [anchorPart!, refs[0]]
      : (cat.onModel ? refs.slice(0, 1) : refs);
    const callInstr = useAnchor ? anchorInstr : imageInstructionsFor(cat, productType, bg);
    let b64: string | null = null;
    let curPrompt = prompts[i];
    let lastErr = "";
    for (let a = 1; a <= 3; a++) {
      if (Date.now() - t0 > BUDGET_MS) break; // past budget → don't start a fresh attempt (the rest come from later passes)
      await pace(); // steady global drip, NOT bursts → DSQ 429s drop (Google: "smoothen traffic, spread requests over time")
      try {
        b64 = await generateImage(apiKey, curPrompt, callRefs, tier.model, tier.location, callInstr, 28_000);
        break;
      } catch (e) {
        const msg = String(e); lastErr = msg;
        if (a >= 3) break;
        // No image / policy block → re-sending the same prompt is futile; VARY it.
        if (/SAFETY_BLOCK|NO_IMAGE|PROHIBIT|RECITATION/i.test(msg)) { curPrompt = varyForSafety(prompts[i], a - 1); continue; }
        // 429 → honor an explicit "retry in Ns" from the error body if present, else
        // capped exponential backoff WITH FULL JITTER (Google's guidance: without
        // jitter, parallel retries re-burst in lockstep and re-trigger 429). The long
        // tail of retries comes from MORE PASSES (MAX_PASSES), not a longer single call.
        if (/\b429\b|RESOURCE_EXHAUSTED/i.test(msg)) {
          const hint = msg.match(/retry in\s+([\d.]+)\s*s/i);
          const wait = (hint ? Math.min(Number(hint[1]) * 1000, 25_000) : Math.min(2000 * 2 ** (a - 1), 16_000)) * (0.5 + Math.random() * 0.5);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    if (!b64) { failTags[i] = tagOf(lastErr); return null; } // failed → retried next pass (bounded by MAX_PASSES)
    try {
      imageUrls[i] = await uploadImage(b64, `${g.user_id}/${g.id}/${i + 1}.jpg`);
      if (driveToken && driveFolderId) {
        try {
          const fbase = (p.sku || productType || "img").replace(/[^\wЀ-ӿ.\-]+/g, "_").slice(0, 80);
          const up = await uploadFileToDrive(driveToken, driveFolderId, `${fbase}_${i + 1}.jpg`, b64);
          driveUrls[i] = up.webViewLink;
        } catch { /* keep storage URL */ }
      }
    } catch { return b64; /* upload failed → slot stays empty, bytes still usable as anchor */ }
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

  // Resolve the identity anchor BEFORE the pool. Already done (later pass) →
  // re-download its bytes; not yet done → generate it first and capture the bytes.
  // If it fails/429s, anchoring is simply skipped this pass (the other person slots
  // fall back to today's product-only flow and retry next pass) — best-effort boost,
  // never a hard dependency, so a 429 degrades gracefully instead of stalling.
  if (anchorIdx >= 0) {
    if (imageUrls[anchorIdx]) {
      const dl = await downloadImageBase64(`${g.user_id}/${g.id}/${anchorIdx + 1}.jpg`);
      if (dl) anchorPart = { inline_data: { mime_type: mimeOfB64(dl), data: dl } };
    } else if (Date.now() - t0 < BUDGET_MS) {
      const b64 = await processSlot(anchorIdx); // anchorPart still null here → product-only flow, correct angle
      if (b64) anchorPart = { inline_data: { mime_type: mimeOfB64(b64), data: b64 } };
    }
  }

  const POOL = fast ? 5 : Math.max(1, Number(process.env.WORKER_IMAGE_POOL) || 8);
  // Build pending AFTER the anchor step. Two anchor-aware exclusions:
  // (1) the anchor slot, once its bytes exist this pass (even if its upload failed),
  //     must not be regenerated in the pool — that would be a wasted 2nd Gemini call.
  // (2) a person angle that needs the anchor is DEFERRED when the anchor isn't ready
  //     (failed/skipped this pass) — it waits for a pass where the anchor succeeds,
  //     so a person shot NEVER generates anchorless and silently drifts. It re-queues
  //     via `remaining` and retries next pass (bounded by MAX_PASSES). Product-only
  //     angles keep generating every pass regardless.
  const pending = Array.from({ length: N }, (_, i) => i).filter((i) =>
    !imageUrls[i] && !rejectedSet.has(i)
    && !(anchorPart && i === anchorIdx)
    && !(needsAnchor(i) && !anchorPart)
  );

  // Pool the slots. POOL caps concurrent calls; a lane stops pulling past the
  // budget (in-flight ones finish, the rest go next pass).
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < pending.length) {
      if (Date.now() - t0 > BUDGET_MS) return;
      await processSlot(pending[cursor++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, pending.length) }, lane));

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
