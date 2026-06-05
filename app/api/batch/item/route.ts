import { createClient } from "@/lib/supabase/server";
import {
  generatePrompts, generateImage, imageInstructionsFor, generateListing,
  type GeminiImagePart, type ProductInfo,
} from "@/lib/gemini";
import { ensureBucket, uploadImage } from "@/lib/supabase/storage";
import {
  resolveApiKey, reserveTokens, refundTokens, restoreFreeGeneration, chargeTokens, creditTokens, TOKEN_COSTS,
} from "@/lib/tokens";
import { resolveAngles, qualityTier, refundForRun } from "@/lib/angles";
import { category } from "@/lib/categories";
import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import net from "node:net";

export const maxDuration = 60; // Vercel Hobby hard cap — don't pretend it's 300

interface BatchItemBody {
  batchId?: string; sku?: string; category?: string;
  productType?: string; name?: string; brand?: string; color?: string; size?: string;
  gender?: string; season?: string; composition?: string; country?: string;
  photoUrls?: string[]; angleIds?: string[]; quality?: string;
  mode?: "images" | "descriptions" | "both";
}

// ── SSRF defence: resolve DNS + reject private/internal targets, follow
// redirects MANUALLY re-checking each hop (mitigates DNS-rebinding & 302→metadata).
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
  const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (m) return isPrivateIp(m[1]);
  return false;
}
async function hostResolvesPublic(host: string): Promise<boolean> {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}
async function safeFetch(url: string, depth = 0): Promise<Response | null> {
  if (depth > 3) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!(await hostResolvesPublic(u.hostname))) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
    clearTimeout(t);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      return safeFetch(new URL(loc, url).toString(), depth + 1);
    }
    return res;
  } catch { clearTimeout(t); return null; }
}
async function fetchImageAsPart(url: string): Promise<GeminiImagePart | null> {
  const res = await safeFetch(url);
  if (!res || !res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 12_000_000) return null;
  const ct = res.headers.get("content-type") ?? "";
  return { inline_data: { mime_type: ct.startsWith("image/") ? ct : "image/jpeg", data: buf.toString("base64") } };
}

const clientMsg = (e: unknown) => {
  const s = e instanceof Error ? e.message : String(e);
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(s)) return "Перевищено ліміт запитів (квота). Спробуйте повільніше.";
  if (/SERVICE_DISABLED|PERMISSION_DENIED|403/i.test(s)) return "Доступ до AI відхилено (перевірте налаштування проєкту).";
  if (/таймаут|timeout|aborted/i.test(s)) return "Таймаут запиту до AI.";
  return "Помилка генерації. Спробуйте ще раз.";
};

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
  const metered = !admin && !byok; // paid/free plans pay for AI; admin & BYOK don't

  // Rate-limit (image work creates generations rows; reuse that as the signal).
  if (!admin) {
    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const { count } = await supabase.from("generations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id).gte("created_at", sinceIso);
    if ((count ?? 0) >= 8) {
      return NextResponse.json({ sku: body.sku, error: "Забагато запитів підряд. Зачекайте хвилину." }, { status: 429 });
    }
  }

  // Reference photos in PARALLEL (bounded) — sequential fetch could blow the 60s budget.
  const refs = (await Promise.all(photoUrls.slice(0, 3).map(fetchImageAsPart))).filter((p): p is GeminiImagePart => !!p);

  const product: ProductInfo = {
    name: body.name, productType, brand: body.brand, color: body.color, size: body.size,
    gender: body.gender, season: body.season, composition: body.composition, country: body.country, sku: body.sku,
  };

  // Helper: meter a listing (cheap text call) — charge paid/free; admin/BYOK free.
  async function meteredListing(): Promise<{ listing?: Awaited<ReturnType<typeof generateListing>>; error?: string }> {
    if (metered) {
      try { await chargeTokens(user!.id, TOKEN_COSTS.prompt_gen, "generation", `AI-опис: ${body.sku ?? ""}`); }
      catch { return { error: "Недостатньо токенів для опису" }; }
    }
    try { return { listing: await generateListing(apiKey, product, refs[0]) }; }
    catch (e) {
      if (metered) await creditTokens(user!.id, TOKEN_COSTS.prompt_gen, "refund", "Повернення: опис не згенеровано").catch(() => {});
      return { error: clientMsg(e) };
    }
  }

  // ── Descriptions-only ──
  if (mode === "descriptions") {
    const r = await meteredListing();
    if (r.error) return NextResponse.json({ sku: body.sku, error: r.error }, { status: 502 });
    return NextResponse.json({ sku: body.sku, listing: r.listing });
  }

  // ── Images (+ optional listing) ──
  if (refs.length === 0) return NextResponse.json({ sku: body.sku, error: "Не вдалося завантажити жодне фото з URL (перевірте посилання)" }, { status: 422 });
  if (!productType) return NextResponse.json({ sku: body.sku, error: "Порожній тип товару (Товар/Вид)" }, { status: 422 });

  const tier = qualityTier(body.quality);
  const angles = (body.angleIds?.length) ? resolveAngles(body.angleIds, cat.angles) : [...cat.angles];
  const N = angles.length;
  const season = body.season ?? "";
  const bg = season ? "lifestyle" : "catalog";

  const { data: gen, error: dbErr } = await supabase.from("generations")
    .insert({
      user_id: user.id, brand: body.brand ?? "", product_type: productType, season,
      gender: body.gender ?? "", category: cat.id, status: "processing",
      batch_id: body.batchId ?? null, sku: body.sku ?? null,
    }).select().single();
  if (dbErr || !gen) return NextResponse.json({ sku: body.sku, error: "DB error" }, { status: 500 });
  const generationId: string = gen.id;

  if (metered && !freeQuota) {
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
    if (metered && !freeQuota) await refundTokens(user.id, generationId, refundForRun(N, 0, tier.tokenMultiplier), "Batch: помилка промптів").catch(() => {});
    if (freeQuota) await restoreFreeGeneration(user.id);
    await supabase.from("generations").update({ status: "error", error_message: "prompt_failed" }).eq("id", generationId);
    return NextResponse.json({ sku: body.sku, error: clientMsg(e) }, { status: 502 });
  }

  const imageUrls: string[] = new Array(N).fill("");
  let done = 0;
  const CONC = Math.min(N, Number(process.env.IMAGE_CONCURRENCY) || 3);
  const queue = angles.map((_, i) => i);
  const imageWork = Promise.all(Array.from({ length: CONC }, async () => {
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
        try { imageUrls[i] = await uploadImage(b64, `${user.id}/${generationId}/${i + 1}.jpg`); done++; } catch { /* slot empty */ }
      }
    }
  }));

  // Run the listing IN PARALLEL with the image pool (mode "both"), metered.
  const listingWork = mode === "both" ? meteredListing() : Promise.resolve({ listing: undefined, error: undefined as string | undefined });
  const [, listingRes] = await Promise.all([imageWork, listingWork]);
  const listing = listingRes.listing ?? null;

  // Reconcile: refund failed images / restore free slot if nothing came out.
  if (metered && !freeQuota) {
    const refund = refundForRun(N, done, tier.tokenMultiplier);
    if (refund > 0) await refundTokens(user.id, generationId, refund, `Batch: повернення за ${N - done} невдалих`).catch(() => {});
  }
  if (freeQuota && done === 0) await restoreFreeGeneration(user.id);
  if (!freeQuota && !admin && done > 0) await supabase.rpc("increment_generations_used", { p_user_id: user.id });

  await supabase.from("generations").update({
    status: done > 0 ? "done" : "error",
    images_generated: done, image_urls: imageUrls, prompts,
    ...(listing ? { listing } : {}),
    ...(done === 0 ? { error_message: "all_images_failed" } : {}),
  }).eq("id", generationId);

  return NextResponse.json({
    sku: body.sku, generationId, urls: imageUrls, done, total: N,
    listing, listingError: listingRes.error,
  });
}
