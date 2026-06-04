import { createClient } from "@/lib/supabase/server";
import {
  generatePrompts, generateImage, imageInstructionsFor, generateListing,
  type GeminiImagePart, type ProductInfo,
} from "@/lib/gemini";
import { ensureBucket, uploadImage } from "@/lib/supabase/storage";
import { resolveApiKey, reserveTokens, refundTokens } from "@/lib/tokens";
import { resolveAngles, qualityTier, refundForRun } from "@/lib/angles";
import { category } from "@/lib/categories";
import { NextResponse } from "next/server";

export const maxDuration = 300; // capped to 60s on Vercel Hobby

interface BatchItemBody {
  batchId?: string;
  sku?: string;
  category?: string;
  productType?: string;   // hero (Товар/Вид)
  name?: string;
  brand?: string;
  color?: string;
  size?: string;
  gender?: string;
  season?: string;        // "", "any", or a season label
  composition?: string;
  country?: string;
  photoUrls?: string[];
  angleIds?: string[];
  quality?: string;
  mode?: "images" | "descriptions" | "both";
}

// Fetch a reference photo by URL (server-side → avoids browser CORS), bounded.
async function fetchImageAsPart(url: string, timeoutMs = 20000): Promise<GeminiImagePart | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 12_000_000) return null;
    const ct = res.headers.get("content-type") ?? "";
    const mime = ct.startsWith("image/") ? ct : "image/jpeg";
    return { inline_data: { mime_type: mime, data: buf.toString("base64") } };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: BatchItemBody;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const mode = body.mode ?? "images";
  const cat = category(body.category);
  const productType = (body.productType || body.name || "").trim();
  const photoUrls = (body.photoUrls ?? []).filter(Boolean);

  let apiKey: string | null;
  let byok: boolean;
  let freeQuota: boolean;
  let admin: boolean;
  try {
    ({ apiKey, byok, freeQuota, admin } = await resolveApiKey(user.id, user.email));
  } catch (e) {
    return NextResponse.json({ sku: body.sku, error: (e as Error).message }, { status: 402 });
  }

  const refs: GeminiImagePart[] = [];
  for (const url of photoUrls.slice(0, 3)) {
    const part = await fetchImageAsPart(url);
    if (part) refs.push(part);
  }

  const product: ProductInfo = {
    name: body.name, productType, brand: body.brand, color: body.color, size: body.size,
    gender: body.gender, season: body.season, composition: body.composition, country: body.country, sku: body.sku,
  };

  // ── Descriptions-only ──
  if (mode === "descriptions") {
    try {
      const listing = await generateListing(apiKey, product, refs[0]);
      return NextResponse.json({ sku: body.sku, listing });
    } catch (e) {
      return NextResponse.json({ sku: body.sku, error: (e as Error).message }, { status: 502 });
    }
  }

  // ── Images (+ optional listing) ──
  if (refs.length === 0) {
    return NextResponse.json({ sku: body.sku, error: "Не вдалося завантажити жодне фото з URL" }, { status: 422 });
  }
  if (!productType) {
    return NextResponse.json({ sku: body.sku, error: "Порожній тип товару (Товар/Вид)" }, { status: 422 });
  }

  const tier = qualityTier(body.quality);
  const angles = (body.angleIds && body.angleIds.length)
    ? resolveAngles(body.angleIds, cat.angles)
    : [...cat.angles];
  const N = angles.length;
  const season = body.season ?? "";
  const bg = season ? "lifestyle" : "catalog";

  const { data: gen, error: dbErr } = await supabase
    .from("generations")
    .insert({
      user_id: user.id, brand: body.brand ?? "", product_type: productType, season,
      gender: body.gender ?? "", category: cat.id, status: "processing",
      batch_id: body.batchId ?? null, sku: body.sku ?? null,
    })
    .select().single();
  if (dbErr || !gen) return NextResponse.json({ sku: body.sku, error: "DB error" }, { status: 500 });
  const generationId: string = gen.id;

  if (!byok && !freeQuota && !admin) {
    try { await reserveTokens(user.id, generationId, N, tier.tokenMultiplier); }
    catch {
      await supabase.from("generations").update({ status: "error", error_message: "insufficient_tokens" }).eq("id", generationId);
      return NextResponse.json({ sku: body.sku, error: "Недостатньо токенів" }, { status: 402 });
    }
  } else if (freeQuota) {
    const { data: consumed } = await supabase.rpc("try_consume_free_generation", { p_user_id: user.id });
    if (consumed !== true) {
      await supabase.from("generations").update({ status: "error", error_message: "free_quota_exhausted" }).eq("id", generationId);
      return NextResponse.json({ sku: body.sku, error: "Вичерпано безкоштовний ліміт" }, { status: 402 });
    }
  }

  await ensureBucket();
  let prompts: string[];
  try {
    prompts = await generatePrompts(apiKey, cat, productType, season, body.gender ?? "", refs, angles);
  } catch (e) {
    if (!byok && !freeQuota && !admin) await refundTokens(user.id, generationId, refundForRun(N, 0, tier.tokenMultiplier), "Batch: помилка промптів").catch(() => {});
    await supabase.from("generations").update({ status: "error", error_message: "prompt_failed" }).eq("id", generationId);
    return NextResponse.json({ sku: body.sku, error: (e as Error).message }, { status: 502 });
  }

  const imageUrls: string[] = new Array(N).fill("");
  let done = 0;
  const CONC = Math.min(N, Number(process.env.IMAGE_CONCURRENCY) || 3);
  const queue = angles.map((_, i) => i);
  await Promise.all(Array.from({ length: CONC }, async () => {
    let idx: number | undefined;
    while ((idx = queue.shift()) !== undefined) {
      const i = idx;
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
        try { imageUrls[i] = await uploadImage(b64, `${user.id}/${generationId}/${i + 1}.jpg`); done++; } catch { /* slot stays empty */ }
      }
    }
  }));

  let listing: Awaited<ReturnType<typeof generateListing>> | null = null;
  if (mode === "both") {
    try { listing = await generateListing(apiKey, product, refs[0]); } catch { /* non-fatal */ }
  }

  if (!byok && !freeQuota && !admin) {
    const refund = refundForRun(N, done, tier.tokenMultiplier);
    if (refund > 0) await refundTokens(user.id, generationId, refund, `Batch: повернення за ${N - done} невдалих`).catch(() => {});
  }
  if (!freeQuota && !admin) await supabase.rpc("increment_generations_used", { p_user_id: user.id });

  await supabase.from("generations").update({
    status: "done", images_generated: done, image_urls: imageUrls, prompts,
    ...(listing ? { listing } : {}),
  }).eq("id", generationId);

  return NextResponse.json({ sku: body.sku, generationId, urls: imageUrls, done, total: N, listing });
}
