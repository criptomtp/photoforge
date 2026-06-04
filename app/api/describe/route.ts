import { createClient } from "@/lib/supabase/server";
import { resolveApiKey } from "@/lib/tokens";
import { generateListing, type ProductInfo, type GeminiImagePart } from "@/lib/gemini";
import { NextResponse } from "next/server";

export const maxDuration = 60;

// Generates a marketplace listing (title/description/bullets/tags) from product
// data + an optional reference photo. Cheap text call — no token charge in v1.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let apiKey: string | null;
  try {
    ({ apiKey } = await resolveApiKey(user.id, user.email));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 402 });
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

  try {
    const listing = await generateListing(apiKey, product, ref);
    return NextResponse.json({ listing });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
