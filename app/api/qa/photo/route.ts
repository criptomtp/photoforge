import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, chargeTokens } from "@/lib/tokens";
import { generateImage, imageInstructionsFor, type GeminiImagePart } from "@/lib/gemini";
import { uploadImage, removeImage } from "@/lib/supabase/storage";
import { qualityTier, TOKEN_COSTS } from "@/lib/angles";
import { category } from "@/lib/categories";
import { getAccessToken, uploadFileToDrive, deleteDriveFile, driveFileId } from "@/lib/google-drive";
import { fetchImageAsPart } from "@/lib/safe-image-fetch";
import { NextResponse } from "next/server";

export const maxDuration = 60;

interface JobParams {
  category?: string; productType?: string; name?: string; gender?: string; season?: string;
  photoUrls?: string[]; quality?: string; sku?: string; drive?: boolean;
}

// Single-photo QA actions: "regen" (replace a slot with a fresh image) or
// "delete" (remove a slot). Both purge the matching Google Drive file.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { generationId?: string; index?: number; action?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { generationId, action } = body;
  const index = Number(body.index);
  if (!generationId || !Number.isInteger(index) || index < 0 || !["regen", "delete"].includes(action ?? ""))
    return NextResponse.json({ error: "bad params" }, { status: 400 });

  const { data: g } = await supabaseAdmin
    .from("generations")
    .select("id, user_id, params, prompts, image_urls, drive_urls, drive_folder_id")
    .eq("id", generationId).single();
  if (!g || g.user_id !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });

  const p: JobParams = (g.params as JobParams) ?? {};
  const imageUrls = Array.isArray(g.image_urls) ? [...(g.image_urls as string[])] : [];
  const driveUrls = Array.isArray(g.drive_urls) ? [...(g.drive_urls as string[])] : [];
  const prompts = Array.isArray(g.prompts) ? (g.prompts as string[]) : [];
  const path = `${g.user_id}/${g.id}/${index + 1}.jpg`;

  // Purge the old Drive file for this slot (both actions replace/remove it).
  let driveToken: string | null = null;
  const oldDriveId = driveFileId(driveUrls[index]);
  if (oldDriveId || (action === "regen" && p.drive)) driveToken = await getAccessToken(user.id).catch(() => null);
  if (driveToken && oldDriveId) await deleteDriveFile(driveToken, oldDriveId);

  if (action === "delete") {
    await removeImage(path);
    imageUrls[index] = "";
    driveUrls[index] = "";
    await supabaseAdmin.from("generations").update({
      image_urls: imageUrls, drive_urls: driveUrls,
      images_generated: imageUrls.filter(Boolean).length,
    }).eq("id", generationId);
    return NextResponse.json({ ok: true, action: "delete", index });
  }

  // ── regen ──────────────────────────────────────────────────────────────
  let ctx;
  try { ctx = await resolveApiKey(user.id, user.email); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }
  const { apiKey, admin, byok } = ctx;
  const metered = !admin && !byok;

  const cat = category(p.category);
  const productType = (p.productType || p.name || "").trim();
  const season = p.season ?? "";
  const bg = season ? "lifestyle" : "catalog";
  const tier = qualityTier(p.quality);

  const refs = (await Promise.all((p.photoUrls ?? []).slice(0, 3).map(fetchImageAsPart)))
    .filter((x): x is GeminiImagePart => !!x);
  if (refs.length === 0) return NextResponse.json({ error: "Немає референсних фото" }, { status: 422 });

  const prompt = prompts[index] || `Professional product photo, angle ${index + 1}.`;
  let b64: string | null = null;
  for (let a = 1; a <= 2; a++) {
    try {
      b64 = await generateImage(apiKey, prompt, refs, tier.model, tier.location, imageInstructionsFor(cat, productType, bg));
      break;
    } catch (e) {
      if (a < 2) await new Promise((r) => setTimeout(r, /\b429\b|RESOURCE_EXHAUSTED/i.test(String(e)) ? 3500 : 600));
    }
  }
  if (!b64) return NextResponse.json({ error: "Генерація не вдалась, спробуйте ще раз" }, { status: 502 });

  // Charge metered users one image only on success (admin/BYOK free).
  if (metered) {
    try { await chargeTokens(user.id, TOKEN_COSTS.image_gen * tier.tokenMultiplier, "image_gen", "Перегенерація фото (QA)"); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }
  }

  imageUrls[index] = await uploadImage(b64, path);
  driveUrls[index] = "";
  if (driveToken && g.drive_folder_id) {
    try {
      const base = (p.sku || productType || "img").replace(/[^\wЀ-ӿ.\-]+/g, "_").slice(0, 80);
      const up = await uploadFileToDrive(driveToken, g.drive_folder_id, `${base}_${index + 1}.jpg`, b64);
      driveUrls[index] = up.webViewLink;
    } catch { /* keep storage URL */ }
  }
  await supabaseAdmin.from("generations").update({
    image_urls: imageUrls, drive_urls: driveUrls,
    images_generated: imageUrls.filter(Boolean).length,
  }).eq("id", generationId);

  return NextResponse.json({ ok: true, action: "regen", index, url: imageUrls[index], driveUrl: driveUrls[index] });
}
