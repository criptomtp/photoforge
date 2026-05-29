import { createClient } from "@/lib/supabase/server";
import { buildOAuthUrl } from "@/lib/google-drive";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL!));
  }

  // CSRF protection: issue a random state nonce and bind it to THIS session via
  // an HttpOnly cookie. The callback derives the user from the session, never
  // from the URL, and verifies this nonce — preventing OAuth state injection.
  const nonce = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildOAuthUrl(nonce));
  res.cookies.set("g_oauth_state", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
