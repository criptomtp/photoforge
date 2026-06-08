import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, chargeTokens, creditTokens } from "@/lib/tokens";
import { generateImage, imageInstructionsFor, sceneSuffix, varyForSafety, bgForScene, type GeminiImagePart, type SceneChoice } from "@/lib/gemini";
import { uploadImage, removeImage } from "@/lib/supabase/storage";
import { resolveAngles, qualityTier, TOKEN_COSTS } from "@/lib/angles";
import { category } from "@/lib/categories";
import { getAccessToken, uploadFileToDrive, deleteDriveFile, driveFileId } from "@/lib/google-drive";
import { fetchImageAsPart } from "@/lib/safe-image-fetch";
import { NextResponse } from "next/server";

export const maxDuration = 60;

interface JobParams {
  category?: string; productType?: string; name?: string; gender?: string; season?: string;
  photoUrls?: string[]; angleIds?: string[]; quality?: string; sku?: string; drive?: boolean;
}

// Single-photo QA actions: "regen" (replace a slot with a fresh image) or
// "delete" (remove a slot). Both purge the matching Google Drive file. The slot
// write goes through the qa_set_slot RPC (FOR UPDATE) so concurrent actions on
// the same generation can't clobber each other's arrays.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { generationId?: string; index?: number; action?: string; scene?: string; note?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const { generationId, action } = body;
  const index = Number(body.index);
  if (!generationId || !Number.isInteger(index) || index < 0 || !["regen", "delete", "reject", "unreject"].includes(action ?? ""))
    return NextResponse.json({ error: "bad params" }, { status: 400 });

  const { data: g } = await supabaseAdmin
    .from("generations")
    .select("id, user_id, params, prompts, drive_urls, drive_folder_id, rejected_slots")
    .eq("id", generationId).single();
  if (!g || g.user_id !== user.id) return NextResponse.json({ error: "not found" }, { status: 404 });

  const p: JobParams = (g.params as JobParams) ?? {};
  const cat = category(p.category);
  const N = (p.angleIds?.length) ? resolveAngles(p.angleIds, cat.angles).length : cat.angles.length;
  if (index >= N) return NextResponse.json({ error: "index out of range" }, { status: 400 });

  const driveUrls = Array.isArray(g.drive_urls) ? (g.drive_urls as string[]) : [];
  const prompts = Array.isArray(g.prompts) ? (g.prompts as string[]) : [];
  const path = `${g.user_id}/${g.id}/${index + 1}.jpg`;
  const oldDriveId = driveFileId(driveUrls[index]);

  const rejectedSlots: number[] = Array.isArray(g.rejected_slots) ? (g.rejected_slots as number[]) : [];

  // ── delete ───────────────────────────────────────────────────────────────
  if (action === "delete") {
    if (oldDriveId) {
      const token = await getAccessToken(user.id).catch(() => null);
      if (token) await deleteDriveFile(token, oldDriveId);
    }
    await removeImage(path);
    await supabaseAdmin.rpc("qa_set_slot", { p_gen_id: g.id, p_index: index, p_image_url: "", p_drive_url: "" });
    return NextResponse.json({ ok: true, action: "delete", index });
  }

  // ── reject (can't generate this angle) / unreject ──────────────────────────
  if (action === "reject" || action === "unreject") {
    if (action === "reject") {
      // also clear any existing image for this slot (storage + Drive)
      if (oldDriveId) { const token = await getAccessToken(user.id).catch(() => null); if (token) await deleteDriveFile(token, oldDriveId); }
      await removeImage(path);
      await supabaseAdmin.rpc("qa_set_slot", { p_gen_id: g.id, p_index: index, p_image_url: "", p_drive_url: "" });
    }
    const next = action === "reject"
      ? Array.from(new Set([...rejectedSlots, index]))
      : rejectedSlots.filter((x) => x !== index);
    await supabaseAdmin.from("generations").update({ rejected_slots: next }).eq("id", g.id).eq("user_id", user.id);
    return NextResponse.json({ ok: true, action, index });
  }

  // ── regen ──────────────────────────────────────────────────────────────
  let ctx;
  try { ctx = await resolveApiKey(user.id, user.email); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }
  const { apiKey, admin, byok } = ctx;
  const metered = !admin && !byok;

  const productType = (p.productType || p.name || "").trim();
  const season = p.season ?? "";
  const scene: SceneChoice = body.scene === "studio" || body.scene === "free" || body.scene === "seasonal"
    ? body.scene
    : (season ? "seasonal" : "studio");
  const bg = bgForScene(scene);
  const tier = qualityTier(p.quality);
  const cost = TOKEN_COSTS.image_gen * tier.tokenMultiplier;

  const refs = (await Promise.all((p.photoUrls ?? []).slice(0, 3).map(fetchImageAsPart)))
    .filter((x): x is GeminiImagePart => !!x);
  if (refs.length === 0) return NextResponse.json({ error: "Немає референсних фото" }, { status: 422 });

  // Charge BEFORE the paid generation (rejects an underfunded user up-front).
  if (metered) {
    try { await chargeTokens(user.id, cost, "image_gen", "Перегенерація фото (QA)"); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }
  }

  // User correction note (e.g. "straps are thin", "back is plain, no print") —
  // appended forcefully so the regen fixes exactly what the user flagged.
  const userNote = (body.note ?? "").toString().trim().slice(0, 600);
  const basePrompt = (prompts[index] || `Professional product photo, angle ${index + 1}.`)
    + sceneSuffix(scene, season)
    + (userNote ? `\n\nВАЖЛИВА ПРИМІТКА КОРИСТУВАЧА — ОБОВ'ЯЗКОВО врахуй і виправ саме це: ${userNote}` : "");
  const instr = imageInstructionsFor(cat, productType, bg);
  let b64: string | null = null;
  let curPrompt = basePrompt;
  // More attempts (429 rejects fast) so a manual regen has more chances to slip
  // through the shared quota; 13s × up to 4 still fits the 60s cap. On a SAFETY/
  // empty block VARY the prompt; on 429/timeout retry as-is.
  for (let a = 1; a <= 4; a++) {
    try {
      b64 = await generateImage(apiKey, curPrompt, refs, tier.model, tier.location, instr, 13_000);
      break;
    } catch (e) {
      const msg = String(e);
      if (a < 4 && /SAFETY_BLOCK|NO_IMAGE|PROHIBIT|RECITATION/i.test(msg)) { curPrompt = varyForSafety(basePrompt, a - 1); continue; }
      if (a < 4) await new Promise((r) => setTimeout(r, /\b429\b|RESOURCE_EXHAUSTED/i.test(msg) ? 2000 : 500));
    }
  }
  if (!b64) {
    if (metered) await creditTokens(user.id, cost, "refund", "Повернення: перегенерація не вдалась").catch(() => {});
    return NextResponse.json({ error: "Генерація не вдалась, спробуйте ще раз" }, { status: 502 });
  }

  // Store first; only then swap the Drive file (so a failed regen never destroys
  // the previous Drive copy).
  let newUrl: string;
  try { newUrl = await uploadImage(b64, path); }
  catch {
    if (metered) await creditTokens(user.id, cost, "refund", "Повернення: збій збереження").catch(() => {});
    return NextResponse.json({ error: "Збій збереження" }, { status: 502 });
  }

  let newDriveUrl = "";
  if (p.drive || oldDriveId) {
    const token = await getAccessToken(user.id).catch(() => null);
    if (token) {
      if (oldDriveId) await deleteDriveFile(token, oldDriveId);
      if (g.drive_folder_id) {
        try {
          const base = (p.sku || productType || "img").replace(/[^\wЀ-ӿ.\-]+/g, "_").slice(0, 80);
          const up = await uploadFileToDrive(token, g.drive_folder_id, `${base}_${index + 1}.jpg`, b64);
          newDriveUrl = up.webViewLink;
        } catch { /* keep storage URL */ }
      }
    }
  }

  await supabaseAdmin.rpc("qa_set_slot", { p_gen_id: g.id, p_index: index, p_image_url: newUrl, p_drive_url: newDriveUrl });
  return NextResponse.json({ ok: true, action: "regen", index, url: newUrl, driveUrl: newDriveUrl });
}
