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

  const { data: claimed } = await supabaseAdmin.rpc("claim_generation");
  const g: GenRow | undefined = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!g) return NextResponse.json({ idle: true });

  const t0 = Date.now();
  try {
    await processJob(g, t0);
  } catch (e) {
    await supabaseAdmin.from("generations")
      .update({ status: "error", error_message: String((e as Error).message).slice(0, 200) })
      .eq("id", g.id);
  }

  const { data: more } = await supabaseAdmin.rpc("queue_has_work");
  if (more === true) kickWorker(2);
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

  let budgetHit = false;
  for (let i = 0; i < N; i++) {
    if (imageUrls[i]) continue;
    if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; break; }
    let b64: string | null = null;
    for (let a = 1; a <= 2; a++) {
      try {
        b64 = await generateImage(apiKey, prompts[i], refs, tier.model, tier.location, imageInstructionsFor(cat, productType, bg));
        break;
      } catch (e) {
        if (a < 2) await new Promise((r) => setTimeout(r, /\b429\b|RESOURCE_EXHAUSTED/i.test(String(e)) ? 3500 : 600));
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
    await supabaseAdmin.from("generations")
      .update({ image_urls: imageUrls, drive_urls: driveUrls, images_generated: imageUrls.filter(Boolean).length })
      .eq("id", g.id);
  }

  const remaining = imageUrls.filter((u) => !u).length;
  if (budgetHit && remaining > 0) {
    // More images to do — make it immediately re-claimable for the next pass.
    await supabaseAdmin.from("generations")
      .update({ status: "processing", claimed_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", g.id);
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
  if (metered && !freeQuota) {
    const refund = refundForRun(N, done, tier.tokenMultiplier);
    if (refund > 0) await refundTokens(g.user_id, g.id, refund, `Повернення за ${N - done} невдалих`).catch(() => {});
  }
  if (freeQuota && done === 0) await restoreFreeGeneration(g.user_id);
  if (!freeQuota && !admin && done > 0) await supabaseAdmin.rpc("increment_generations_used", { p_user_id: g.user_id });

  await supabaseAdmin.from("generations").update({
    status: done > 0 ? "done" : "error",
    images_generated: done,
    image_urls: imageUrls,
    drive_urls: driveUrls,
    ...(listing ? { listing } : {}),
    ...(done === 0 ? { error_message: "all_images_failed" } : {}),
  }).eq("id", g.id);
}
