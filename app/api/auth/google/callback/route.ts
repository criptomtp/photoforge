import { exchangeCode, storeGoogleTokens } from "@/lib/google-drive";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code  = searchParams.get("code");
  const state = searchParams.get("state"); // userId
  const error = searchParams.get("error");

  if (error || !code || !state) {
    return NextResponse.redirect(
      `${origin}/dashboard/settings?google_error=${error ?? "missing_params"}`
    );
  }

  try {
    const tokens = await exchangeCode(code);
    await storeGoogleTokens(state, tokens.access_token, tokens.refresh_token, tokens.expires_in);
    return NextResponse.redirect(`${origin}/dashboard/settings?google_connected=1`);
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return NextResponse.redirect(`${origin}/dashboard/settings?google_error=exchange_failed`);
  }
}
