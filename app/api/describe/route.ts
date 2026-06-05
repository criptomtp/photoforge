import { createClient } from "@/lib/supabase/server";
import { resolveApiKey, chargeTokens, creditTokens, TOKEN_COSTS } from "@/lib/tokens";
import { generateListing, type ProductInfo, type GeminiImagePart } from "@/lib/gemini";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const clientMsg = (e: unknown) => {
  const s = e instanceof Error ? e.message : String(e);
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(s)) return "Перевищено ліміт запитів (квота).";
  if (/таймаут|timeout|aborted/i.test(s)) return "Таймаут запиту до AI.";
  return "Не вдалося згенерувати опис. Спробуйте ще раз.";
};

// Generates a marketplace listing from product data + an optional reference photo.
// Metered: a small token charge for paid/free plans (admin & BYOK free).
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let apiKey: string | null;
  let byok: boolean;
  let admin: boolean;
  try {
    ({ apiKey, byok, admin } = await resolveApiKey(user.id, user.email));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 402 });
  }
  const metered = !admin && !byok;

  // Per-minute rate-limit on this endpoint (it isn't gated by the generations table).
  if (!admin) {
    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const { count } = await supabase.from("token_transactions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id).gte("created_at", sinceIso);
    if ((count ?? 0) >= 30) {
      return NextResponse.json({ error: "Забагато запитів підряд. Зачекайте хвилину." }, { status: 429 });
    }
  }

  const fd = await request.formData();
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const product: ProductInfo = {
    name: str("name"),
    productType: str("productType"),
    brand: str("brand"),
    color: str("color"),
    size: str("size"),
    gender: str("gender"),
    season: str("season"),
    composition: str("composition"),
    country: str("country"),
    sku: str("sku"),
  };

  const imageFile = fd.get("image");
  let ref: GeminiImagePart | undefined;
  if (imageFile && typeof imageFile !== "string") {
    const buf = Buffer.from(await imageFile.arrayBuffer()).toString("base64");
    ref = { inline_data: { mime_type: "image/jpeg", data: buf } };
  }

  if (metered) {
    try { await chargeTokens(user.id, TOKEN_COSTS.prompt_gen, "generation", "AI-опис"); }
    catch { return NextResponse.json({ error: "Недостатньо токенів для опису" }, { status: 402 }); }
  }

  try {
    const listing = await generateListing(apiKey, product, ref);
    return NextResponse.json({ listing });
  } catch (e) {
    if (metered) await creditTokens(user.id, TOKEN_COSTS.prompt_gen, "refund", "Повернення: опис не згенеровано").catch(() => {});
    return NextResponse.json({ error: clientMsg(e) }, { status: 502 });
  }
}
