import { supabaseAdmin as supabase } from "./admin";

const BUCKET = "generations";
// 7 days — long enough for the live flow, the client ZIP download, and the
// Google Drive re-fetch, all of which happen within minutes of generation.
const SIGNED_URL_TTL = 60 * 60 * 24 * 7;

export async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  const existing = buckets?.find((b) => b.name === BUCKET);
  if (!existing) {
    // Private: generated photos are reachable only via short-lived signed URLs.
    await supabase.storage.createBucket(BUCKET, { public: false });
  } else if (existing.public) {
    // Migrate a previously-public bucket to private — closes the world-readable
    // hole where any generated customer photo was fetchable by URL forever.
    // Best-effort: signed URLs work regardless of visibility, so a failure here
    // must NOT abort the generation.
    const { error: visErr } = await supabase.storage.updateBucket(BUCKET, { public: false });
    if (visErr) console.error("Failed to make bucket private:", visErr.message);
  }
}

export async function uploadImage(
  base64: string,
  path: string
): Promise<string> {
  const buffer = Buffer.from(base64, "base64");

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  if (signErr || !data?.signedUrl) {
    throw new Error(`Signed URL failed: ${signErr?.message ?? "unknown"}`);
  }

  return data.signedUrl;
}

/** Best-effort delete of a stored image by path. */
export async function removeImage(path: string): Promise<void> {
  try { await supabase.storage.from(BUCKET).remove([path]); } catch { /* ignore */ }
}

/** Download a stored image as base64 (used as the "same model" anchor reference). */
export async function downloadImageBase64(path: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer()).toString("base64");
  } catch { return null; }
}
