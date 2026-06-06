import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { category } from "@/lib/categories";
import { resolveAngles } from "@/lib/angles";
import { NextResponse } from "next/server";

export const maxDuration = 30;
const BUCKET = "generations";

interface RowParams {
  angleIds?: string[]; category?: string; photoUrls?: string[];
  productType?: string; name?: string; sku?: string; season?: string;
}

// QA data for a batch: per-product originals + generated slots (fresh signed
// URLs minted now, since stored ones can expire) + Drive links + status.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { batchId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: rows } = await supabase
    .from("generations")
    .select("id, sku, status, images_generated, image_urls, drive_urls, params, created_at, approved")
    .eq("batch_id", batchId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const gens = rows ?? [];

  // Mint fresh signed URLs for every non-empty generated slot in one call.
  const pathFor = (id: string, i: number) => `${user.id}/${id}/${i + 1}.jpg`;
  const paths: string[] = [];
  for (const g of gens) {
    const arr = Array.isArray(g.image_urls) ? (g.image_urls as string[]) : [];
    arr.forEach((u, i) => { if (u) paths.push(pathFor(g.id as string, i)); });
  }
  const urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 2);
    for (const s of signed ?? []) if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
  }

  const items = gens.map((g) => {
    const pr: RowParams = (g.params as RowParams) ?? {};
    const cat = category(pr.category);
    const angles = (pr.angleIds?.length) ? resolveAngles(pr.angleIds, cat.angles) : [...cat.angles];
    const total = angles.length;
    const imgs = Array.isArray(g.image_urls) ? (g.image_urls as string[]) : [];
    const drv = Array.isArray(g.drive_urls) ? (g.drive_urls as string[]) : [];
    const slots = Array.from({ length: total }, (_, i) => ({
      index: i,
      angle: angles[i]?.label ?? `Ракурс ${i + 1}`,
      url: imgs[i] ? (urlByPath.get(pathFor(g.id as string, i)) ?? "") : "",
      driveUrl: drv[i] || "",
    }));
    return {
      id: g.id as string,
      sku: (g.sku as string) ?? "",
      productType: (pr.productType || pr.name || "").trim(),
      status: g.status as string,
      done: (g.images_generated as number) ?? 0,
      total,
      season: pr.season ?? "",
      approved: !!g.approved,
      originals: (pr.photoUrls ?? []).slice(0, 9),
      slots,
    };
  });

  return NextResponse.json({ batchId, items });
}
