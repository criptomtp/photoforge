import { createClient } from "@/lib/supabase/server";
import { resolveApiKey } from "@/lib/tokens";
import { classifyProducts } from "@/lib/gemini";
import { NextResponse } from "next/server";

export const maxDuration = 60;

const VALID = new Set(["clothing", "shoes", "jewelry", "accessories", "object"]);

// AI category classification for bulk: takes product names, returns {name: id}.
// Free helper (cheap text); admin/BYOK/platform key all work. The client only
// sends names that keyword-matching couldn't place.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { names?: string[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  // Dedupe + trim + cap.
  const uniq = Array.from(new Set((body.names ?? []).map((n) => String(n).trim()).filter(Boolean))).slice(0, 1500);
  if (uniq.length === 0) return NextResponse.json({ byName: {} });

  let apiKey: string | null;
  try { ({ apiKey } = await resolveApiKey(user.id, user.email)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 402 }); }

  // Chunk so each model response stays manageable.
  const CHUNK = 120;
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));

  const byName: Record<string, string> = {};
  // Small concurrency to keep within maxDuration without hammering the model.
  const POOL = 3;
  let cursor = 0;
  const lane = async () => {
    while (cursor < chunks.length) {
      const c = chunks[cursor++];
      try {
        const res = await classifyProducts(apiKey, c);
        for (const [name, cat] of Object.entries(res)) {
          if (typeof cat === "string" && VALID.has(cat)) byName[name] = cat;
        }
      } catch { /* skip this chunk → those names fall back to keyword/dropdown */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, chunks.length) }, lane));

  return NextResponse.json({ byName });
}
