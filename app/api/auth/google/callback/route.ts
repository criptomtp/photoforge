import { createClient } from "@/lib/supabase/server";
import { exchangeCode, storeGoogleTokens } from "@/lib/google-drive";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code  = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const fail = (reason: string) => {
    const res = NextResponse.redirect(`${origin}/dashboard/settings?google_error=${reason}`);
    res.cookies.delete("g_oauth_state"); // consume the nonce on every terminal path
    return res;
  };

  if (error || !code || !state) {
    return fail(error ?? "missing_params");
  }

  // The user must be authenticated; we write tokens to THEIR profile, not to a
  // user id taken from the URL (which an attacker controls).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("not_authenticated");

  // CSRF: the returned state must match the nonce issued to this session.
  const cookieStore = await cookies();
  const expected = cookieStore.get("g_oauth_state")?.value;
  if (!expected || expected !== state) return fail("state_mismatch");

  try {
    const tokens = await exchangeCode(code);
    await storeGoogleTokens(user.id, tokens.access_token, tokens.refresh_token, tokens.expires_in);
    const res = NextResponse.redirect(`${origin}/dashboard/settings?google_connected=1`);
    res.cookies.delete("g_oauth_state");
    return res;
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return fail("exchange_failed");
  }
}
