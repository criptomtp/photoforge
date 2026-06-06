import { createClient } from "@/lib/supabase/server";
import { category } from "@/lib/categories";
import { NextResponse } from "next/server";

export const maxDuration = 20;

interface RowParams { angleIds?: string[]; category?: string }

// Per-SKU status across ALL of the user's past generations (latest wins). The
// bulk tab uses this to mark which Артикули are already generated/approved and
// filter them out, so the user doesn't redo finished work.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: rows } = await supabase
    .from("generations")
    .select("sku, status, images_generated, approved, batch_id, params, created_at")
    .eq("user_id", user.id)
    .not("sku", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);

  // First row per SKU is the latest (ordered desc).
  const bySku: Record<string, {
    status: string; done: number; total: number; approved: boolean; batchId: string | null; at: string;
  }> = {};
  for (const r of rows ?? []) {
    const sku = (r.sku as string) ?? "";
    if (!sku || bySku[sku]) continue;
    const pr: RowParams = (r.params as RowParams) ?? {};
    const total = (pr.angleIds?.length) || category(pr.category).angles.length;
    bySku[sku] = {
      status: r.status as string,
      done: (r.images_generated as number) ?? 0,
      total,
      approved: !!r.approved,
      batchId: (r.batch_id as string) ?? null,
      at: r.created_at as string,
    };
  }

  return NextResponse.json({ bySku });
}
