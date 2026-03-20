import { createClient } from "@/lib/supabase/server";
import { createClient as createAdmin } from "@supabase/supabase-js";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextResponse } from "next/server";

const ADMIN_EMAIL = "criptomtp@gmail.com";

async function assertAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== ADMIN_EMAIL) {
    throw new Error("Forbidden");
  }
  return user;
}

const admin = createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    await assertAdmin();
    const { data, error } = await admin
      .from("platform_settings")
      .select("*")
      .eq("id", 1)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Mask the key — show only last 4 chars
    const gemini_api_key_masked = data.gemini_api_key
      ? `AIza...${decrypt(data.gemini_api_key).slice(-4)}`
      : null;

    const vertex_ai_active = !!process.env.GOOGLE_VERTEX_SA_KEY;
    return NextResponse.json({ ...data, gemini_api_key: undefined, gemini_api_key_masked, vertex_ai_active });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(request: Request) {
  try {
    await assertAdmin();
    const body = await request.json();

    const update: Record<string, unknown> = {
      cost_per_prompt_gen: body.cost_per_prompt_gen,
      cost_per_image_gen: body.cost_per_image_gen,
      free_plan_tokens: body.free_plan_tokens,
      pricing_starter_usd: body.pricing_starter_usd,
      pricing_pro_usd: body.pricing_pro_usd,
      maintenance_mode: body.maintenance_mode,
      updated_at: new Date().toISOString(),
    };

    if (body.gemini_api_key?.trim()) {
      update.gemini_api_key = encrypt(body.gemini_api_key.trim());
    }

    const { data, error } = await admin
      .from("platform_settings")
      .update(update)
      .eq("id", 1)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const gemini_api_key_masked = data.gemini_api_key
      ? `AIza...${decrypt(data.gemini_api_key).slice(-4)}`
      : null;

    return NextResponse.json({ ...data, gemini_api_key: undefined, gemini_api_key_masked });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 500 });
  }
}
