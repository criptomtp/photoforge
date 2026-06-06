import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

// Persist a QA approval flag on a generation (ownership-checked).
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { generationId?: string; approved?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!body.generationId) return NextResponse.json({ error: "bad params" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("generations")
    .update({ approved: !!body.approved })
    .eq("id", body.generationId)
    .eq("user_id", user.id)
    .select("id");
  if (error || !data || data.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ ok: true, approved: !!body.approved });
}
