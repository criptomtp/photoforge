import { createClient } from "@/lib/supabase/server";
import { getAccessToken, createDriveFolder } from "@/lib/google-drive";
import { NextResponse } from "next/server";

export const maxDuration = 20;

const safeId = (id: string | null) => (id && /^[-\w]+$/.test(id) ? id : "root");

// GET ?parentId=<id|root> → child folders for the picker tree.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken(user.id).catch(() => null);
  if (!token) return NextResponse.json({ error: "google_not_connected" }, { status: 400 });

  const parentId = safeId(new URL(request.url).searchParams.get("parentId"));
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name&pageSize=300`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    // Old token without the new (full-drive) scope → user must reconnect Google.
    if (res.status === 401 || res.status === 403) return NextResponse.json({ error: "reconnect_google" }, { status: 403 });
    return NextResponse.json({ error: "drive_error" }, { status: 502 });
  }
  const data = await res.json();
  const folders = (data.files ?? []).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));
  return NextResponse.json({ parentId, folders });
}

// POST { name, parentId } → create a folder, return it.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken(user.id).catch(() => null);
  if (!token) return NextResponse.json({ error: "google_not_connected" }, { status: 400 });

  let body: { name?: string; parentId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const name = (body.name ?? "").trim().slice(0, 100);
  if (!name) return NextResponse.json({ error: "Вкажіть назву папки" }, { status: 422 });

  try {
    const folder = await createDriveFolder(token, name, safeId(body.parentId ?? "root"));
    return NextResponse.json({ id: folder.id, name });
  } catch {
    return NextResponse.json({ error: "reconnect_google" }, { status: 403 });
  }
}
