import { createClient } from "@/lib/supabase/server";
import { disconnectGoogle } from "@/lib/google-drive";
import { NextResponse } from "next/server";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await disconnectGoogle(user.id);
  return NextResponse.json({ ok: true });
}
