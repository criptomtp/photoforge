import { createClient } from "@/lib/supabase/server";
import { getAccessToken, createDriveFolder } from "@/lib/google-drive";
import { NextResponse } from "next/server";

export const maxDuration = 30;

// Creates (or returns) a parent Drive folder so a batch's product folders nest
// under one place instead of scattering across the Drive root.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken(user.id).catch(() => null);
  if (!token) return NextResponse.json({ error: "Google не підключено в Налаштуваннях" }, { status: 400 });

  const { name } = await request.json().catch(() => ({ name: "PhotoForge" }));
  try {
    const f = await createDriveFolder(token, String(name || "PhotoForge").slice(0, 100));
    return NextResponse.json({ id: f.id, webViewLink: f.webViewLink });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
