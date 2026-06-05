import { createClient } from "@/lib/supabase/server";
import { category } from "@/lib/categories";
import { kickWorker } from "@/lib/factory";
import { NextResponse } from "next/server";

export const maxDuration = 30;

interface RowParams { angleIds?: string[]; category?: string; photoUrls?: string[] }

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
    .select("id, sku, status, images_generated, image_urls, drive_urls, params, listing, error_message")
    .eq("batch_id", batchId)
    .eq("user_id", user.id);

  const items = (rows ?? []).map((r) => {
    const pr: RowParams = (r.params as RowParams) ?? {};
    const total = (pr.angleIds?.length) || category(pr.category).angles.length;
    return {
      id: r.id as string,
      sku: (r.sku as string) ?? "",
      status: r.status as string,
      done: (r.images_generated as number) ?? 0,
      total,
      urls: Array.isArray(r.image_urls) ? (r.image_urls as string[]) : [],
      driveUrls: Array.isArray(r.drive_urls) ? (r.drive_urls as string[]) : [],
      photoUrls: pr.photoUrls ?? [],
      listing: r.listing ?? null,
      error: (r.error_message as string) ?? null,
    };
  });

  // Keep the queue draining while the client polls (belt to the self-re-trigger).
  if (items.some((i) => i.status === "queued" || i.status === "processing")) kickWorker(1);

  return NextResponse.json({ items });
}
