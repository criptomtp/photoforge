import { GoogleAuth } from "google-auth-library";

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!_auth) {
    const saKey = process.env.GOOGLE_VERTEX_SA_KEY;
    if (!saKey) throw new Error("GOOGLE_VERTEX_SA_KEY is not set");
    _auth = new GoogleAuth({
      credentials: JSON.parse(saKey),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return _auth;
}

export async function getVertexToken(): Promise<string> {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to get Vertex AI access token");
  return token.token;
}

export const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "";
export const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

// Model names on Vertex AI (can override via env)
export const VERTEX_PROMPT_MODEL =
  process.env.VERTEX_PROMPT_MODEL ?? "gemini-2.5-flash";
export const VERTEX_IMAGE_MODEL =
  process.env.VERTEX_IMAGE_MODEL ?? "gemini-2.0-flash-exp";
