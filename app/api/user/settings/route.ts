import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  const update: Record<string, unknown> = {};

  if ("gemini_api_key" in body) {
    if (body.gemini_api_key === null || body.gemini_api_key === "") {
      update.gemini_api_key = null;
    } else {
      const key = String(body.gemini_api_key).trim();
      if (!key.startsWith("AIza") || key.length < 20) {
        return NextResponse.json(
          { error: "Невірний формат Gemini API ключа (повинен починатись з AIza)" },
          { status: 400 }
        );
      }
      update.gemini_api_key = encrypt(key);
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
