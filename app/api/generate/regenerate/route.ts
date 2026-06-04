import { createClient } from "@/lib/supabase/server";
import { generateImage, imageInstructionsFor, type GeminiImagePart } from "@/lib/gemini";
import { uploadImage } from "@/lib/supabase/storage";
import { resolveApiKey } from "@/lib/tokens";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TOKEN_COSTS } from "@/lib/angles";
import { category } from "@/lib/categories";
import { NextResponse } from "next/server";

export const maxDuration = 120;

// Regenerate a SINGLE image of an existing generation (the "fix this one photo"
// button). Re-runs one prompt with retries and overwrites that slot.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const generationId = formData.get("generationId") as string;
  const index = parseInt(formData.get("index") as string, 10);
  const prompt = (formData.get("prompt") as string) ?? "";
  const imageFiles = formData.getAll("images") as File[];

  if (!generationId || Number.isNaN(index) || index < 0 || prompt.length < 20 || imageFiles.length === 0) {
    return NextResponse.json({ error: "Невірні параметри запиту" }, { status: 400 });
  }

  // Ownership check (the row must belong to the caller).
  const { data: gen } = await supabase
    .from("generations")
    .select("id, image_urls, category, product_type")
    .eq("id", generationId)
    .eq("user_id", user.id)
    .single();
  if (!gen) return NextResponse.json({ error: "Генерацію не знайдено" }, { status: 404 });
  const cat = category(gen.category as string | undefined);
  const product = (gen.product_type as string | undefined) ?? "";

  let apiKey: string | null;
  let byok: boolean;
  let freeQuota: boolean;
  let admin: boolean;
  try {
    ({ apiKey, byok, freeQuota, admin } = await resolveApiKey(user.id, user.email));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 402 });
  }

  const referenceParts: GeminiImagePart[] = await Promise.all(
    imageFiles.slice(0, 9).map(async (file) => ({
      inline_data: {
        mime_type: "image/jpeg",
        data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      },
    }))
  );

  // Retry the single image (same policy as the main generate loop).
  let base64: string | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      base64 = await generateImage(apiKey, prompt, referenceParts, undefined, undefined, imageInstructionsFor(cat, product));
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  if (!base64) {
    return NextResponse.json({ error: lastErr || "Не вдалося згенерувати фото" }, { status: 502 });
  }

  // Overwrite that slot in storage + the image_urls array.
  const path = `${user.id}/${generationId}/${index + 1}.jpg`;
  const url = await uploadImage(base64, path);

  const urls: string[] = Array.isArray(gen.image_urls) ? [...gen.image_urls] : [];
  while (urls.length <= index) urls.push("");
  urls[index] = url;
  await supabaseAdmin.from("generations").update({ image_urls: urls }).eq("id", generationId);

  // Charge paid users for the one image (only on success). BYOK / free-quota /
  // Vertex pay nothing here.
  if (!byok && !freeQuota && !admin) {
    try {
      await supabaseAdmin.rpc("deduct_tokens_tx", {
        p_user_id: user.id,
        p_amount: TOKEN_COSTS.image_gen,
        p_kind: "generation",
        p_description: "Перегенерація 1 фото",
        p_generation_id: generationId,
      });
    } catch { /* best effort — image already delivered */ }
  }

  return NextResponse.json({ url });
}
