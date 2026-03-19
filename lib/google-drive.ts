import { encrypt, decrypt } from "./crypto";
import { createClient as createAdmin } from "@supabase/supabase-js";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");

const REDIRECT_URI = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/google/callback`;

const admin = createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── OAuth URL ──────────────────────────────────────────────────────────────

export function buildOAuthUrl(userId: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: userId, // passed back in callback
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Exchange code for tokens ───────────────────────────────────────────────

export async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  return res.json();
}

// ── Refresh access token ───────────────────────────────────────────────────

export async function refreshAccessToken(encryptedRefreshToken: string): Promise<string> {
  const refreshToken = decrypt(encryptedRefreshToken);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error("Failed to refresh Google access token");

  const data = await res.json();
  return data.access_token;
}

// ── Get valid access token for user (auto-refresh) ────────────────────────

export async function getAccessToken(userId: string): Promise<string | null> {
  const { data: profile } = await admin
    .from("profiles")
    .select("google_access_token, google_refresh_token, google_token_expires_at")
    .eq("id", userId)
    .single();

  if (!profile?.google_refresh_token) return null;

  const expiresAt = profile.google_token_expires_at
    ? new Date(profile.google_token_expires_at).getTime()
    : 0;

  // Refresh if expired (or within 60s of expiry)
  if (!profile.google_access_token || Date.now() > expiresAt - 60_000) {
    const newToken = await refreshAccessToken(profile.google_refresh_token);
    const newExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

    await admin
      .from("profiles")
      .update({
        google_access_token: encrypt(newToken),
        google_token_expires_at: newExpiry,
      })
      .eq("id", userId);

    return newToken;
  }

  return decrypt(profile.google_access_token);
}

// ── Drive API helpers ──────────────────────────────────────────────────────

async function driveRequest(
  path: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers ?? {}),
    },
  });
}

export async function createDriveFolder(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<{ id: string; webViewLink: string }> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await driveRequest(
    "/drive/v3/files?fields=id,webViewLink",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    }
  );

  if (!res.ok) throw new Error(`Drive folder creation failed: ${await res.text()}`);
  return res.json();
}

export async function uploadFileToDrive(
  accessToken: string,
  folderId: string,
  fileName: string,
  base64Data: string
): Promise<{ id: string; webViewLink: string }> {
  const boundary = "photoforge_boundary";
  const imgBuffer = Buffer.from(base64Data, "base64");

  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  });

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: image/jpeg",
    "",
  ].join("\r\n");

  const bodyEnd = `\r\n--${boundary}--`;

  const fullBody = Buffer.concat([
    Buffer.from(body, "utf-8"),
    imgBuffer,
    Buffer.from(bodyEnd, "utf-8"),
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(fullBody.length),
      },
      body: fullBody,
    }
  );

  if (!res.ok) throw new Error(`Drive upload failed: ${await res.text()}`);
  return res.json();
}

// ── Store tokens in DB after OAuth ───────────────────────────────────────

export async function storeGoogleTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number
): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  await admin.from("profiles").update({
    google_access_token: encrypt(accessToken),
    google_refresh_token: encrypt(refreshToken),
    google_token_expires_at: expiresAt,
    google_drive_connected: true,
    google_sheets_connected: true, // same token covers both scopes
  }).eq("id", userId);
}

// ── Disconnect (revoke + clear) ───────────────────────────────────────────

export async function disconnectGoogle(userId: string): Promise<void> {
  const { data: profile } = await admin
    .from("profiles")
    .select("google_access_token")
    .eq("id", userId)
    .single();

  if (profile?.google_access_token) {
    const token = decrypt(profile.google_access_token);
    // Best-effort revoke
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
      method: "POST",
    }).catch(() => null);
  }

  await admin.from("profiles").update({
    google_access_token: null,
    google_refresh_token: null,
    google_token_expires_at: null,
    google_drive_connected: false,
    google_sheets_connected: false,
  }).eq("id", userId);
}
