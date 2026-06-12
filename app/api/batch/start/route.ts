import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveApiKey, reserveTokens } from "@/lib/tokens";
import { resolveAngles, qualityTier, TOKEN_COSTS } from "@/lib/angles";
import { category } from "@/lib/categories";
import { getAccessToken, createDriveFolder } from "@/lib/google-drive";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export const maxDuration = 60;

interface ProductIn {
  sku?: string; productType?: string; name?: string; brand?: string; color?: string;
  size?: string; gender?: string; season?: string; composition?: string; country?: string;
  photoUrls?: string[];
  category?: string; angleIds?: string[]; // per-product (auto-detected on client)
}
interface StartBody {
  products: ProductIn[];
  category?: string; quality?: string; mode?: "images" | "both";
  angleIds?: string[]; drive?: boolean; driveFolderName?: string; driveParentId?: string; draft?: boolean;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: StartBody;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const products = (body.products ?? []).filter((p) => (p.photoUrls?.length) && (p.productType || p.name));
  if (products.length === 0) return NextResponse.json({ error: "Немає придатних товарів" }, { status: 422 });
  if (products.length > 500) return NextResponse.json({ error: "Забагато товарів за раз (макс 500)" }, { status: 422 });

  let apiKeyCtx;
  try { apiKeyCtx = await resolveApiKey(user.id, user.email); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }
  const { admin, byok, freeQuota } = apiKeyCtx;
  const metered = !admin && !byok;

  const tier = qualityTier(body.quality);
  const batchId = randomUUID();

  // Parent Drive folder: either a folder the user PICKED from the tree, or create
  // a new one from the typed name. Products nest under it.
  let driveParentId: string | undefined;
  if (body.drive) {
    if (body.driveParentId && /^[-\w]+$/.test(body.driveParentId)) {
      driveParentId = body.driveParentId; // picked existing folder
    } else if (body.driveFolderName?.trim()) {
      const token = await getAccessToken(user.id).catch(() => null);
      if (token) {
        try { driveParentId = (await createDriveFolder(token, body.driveFolderName.trim().slice(0, 100))).id; } catch { /* ignore */ }
      }
    }
  }

  const draft = !!body.draft; // step-by-step card mode: enqueue but don't process yet
  let queued = 0;
  for (const pr of products) {
    // Per-product category + angles (auto-detected on the client; fall back to
    // the batch default). A mixed file routes each item correctly.
    const pcat = category(pr.category || body.category);
    const pAngleIds = (pr.angleIds?.length ? pr.angleIds : body.angleIds) ?? [];
    const resolved = pAngleIds.length ? resolveAngles(pAngleIds, pcat.angles) : [];
    const N = resolved.length || pcat.angles.length; // never 0 (else no images)
    const params = {
      userEmail: user.email, category: pcat.id,
      productType: (pr.productType || pr.name || "").trim(), name: pr.name,
      brand: pr.brand, color: pr.color, size: pr.size, gender: pr.gender, season: pr.season,
      composition: pr.composition, country: pr.country, sku: pr.sku,
      photoUrls: (pr.photoUrls ?? []).filter(Boolean).slice(0, 9),
      angleIds: resolved.length ? pAngleIds : [], quality: tier.id, mode: body.mode ?? "images",
      drive: !!body.drive, driveParentId,
    };
    const billingKind = (admin || byok) ? "none" : (freeQuota ? "free" : "metered");
    const { data: gen, error } = await supabaseAdmin.from("generations").insert({
      user_id: user.id, batch_id: batchId, sku: pr.sku ?? null, category: pcat.id,
      product_type: params.productType, season: pr.season ?? "", gender: pr.gender ?? "",
      status: draft ? "draft" : "queued", params, image_urls: [],
      billing_kind: billingKind, refund_unit: TOKEN_COSTS.image_gen * tier.tokenMultiplier, images_target: N,
    }).select("id").single();
    if (error || !gen) continue;

    // Draft: reserve tokens later, when the user actually generates it. Just count.
    if (draft) { queued++; continue; }

    // Charge up-front (worker refunds failures). Admin/BYOK free.
    if (metered && !freeQuota) {
      try { await reserveTokens(user.id, gen.id, N, tier.tokenMultiplier); queued++; }
      catch {
        await supabaseAdmin.from("generations").update({ status: "error", error_message: "insufficient_tokens" }).eq("id", gen.id);
      }
    } else if (freeQuota) {
      const { data: ok } = await supabaseAdmin.rpc("try_consume_free_generation", { p_user_id: user.id });
      if (ok === true) queued++;
      else await supabaseAdmin.from("generations").update({ status: "error", error_message: "free_quota_exhausted" }).eq("id", gen.id);
    } else {
      queued++; // admin / byok
    }
  }

  if (!draft) await kickWorker(3); // drafts wait for the user to trigger each one
  return NextResponse.json({ batchId, queued, total: products.length });
}
