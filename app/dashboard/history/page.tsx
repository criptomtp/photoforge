import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const revalidate = 0;

const BUCKET = "generations";

interface GenRow {
  id: string;
  batch_id: string | null;
  brand: string | null;
  product_type: string | null;
  season: string | null;
  gender: string | null;
  status: string;
  images_generated: number | null;
  image_urls: string[] | null;
  created_at: string;
}

interface BatchSummary {
  batchId: string;
  products: number;
  photos: number;
  done: number;
  errors: number;
  lastDate: string;
}

export default async function HistoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Single generations (newest 30, excluding bulk-batch rows).
  const { data: generations } = user
    ? await supabase
        .from("generations")
        .select("id, batch_id, brand, product_type, season, gender, status, images_generated, image_urls, created_at")
        .eq("user_id", user.id)
        .is("batch_id", null)
        .order("created_at", { ascending: false })
        .limit(30)
    : { data: [] as GenRow[] };

  // Bulk batches — grouped summary with a link to the QA view.
  const { data: batchRows } = user
    ? await supabase
        .from("generations")
        .select("batch_id, status, images_generated, created_at")
        .eq("user_id", user.id)
        .not("batch_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(2000)
    : { data: [] };

  const batchMap = new Map<string, BatchSummary>();
  for (const r of (batchRows ?? []) as Array<{ batch_id: string; status: string; images_generated: number | null; created_at: string }>) {
    const b = batchMap.get(r.batch_id) ?? { batchId: r.batch_id, products: 0, photos: 0, done: 0, errors: 0, lastDate: r.created_at };
    b.products += 1;
    b.photos += r.images_generated ?? 0;
    if (r.status === "done") b.done += 1;
    if (r.status === "error") b.errors += 1;
    if (r.created_at > b.lastDate) b.lastDate = r.created_at;
    batchMap.set(r.batch_id, b);
  }
  const batches = [...batchMap.values()].sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));

  const gens = (generations ?? []) as GenRow[];

  // Fresh signed URLs for single-generation thumbnails (bucket is private).
  const pathFor = (genId: string, i: number) => `${user!.id}/${genId}/${i + 1}.jpg`;
  const allPaths: string[] = [];
  if (user) {
    for (const g of gens) (g.image_urls ?? []).forEach((u, i) => { if (u) allPaths.push(pathFor(g.id, i)); });
  }
  const urlByPath = new Map<string, string>();
  if (allPaths.length > 0) {
    const { data: signed } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(allPaths, 60 * 60);
    for (const s of signed ?? []) if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Історія генерацій</h1>
        <p className="text-[#6B6560] mt-1">Партії масової генерації та окремі фото</p>
      </div>

      {/* ── Bulk batches ─────────────────────────────────────────────── */}
      {batches.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-heading text-lg font-semibold text-[#F5F0EB]">Партії (масова генерація)</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {batches.map((b) => (
              <Link
                key={b.batchId}
                href={`/dashboard/history/${b.batchId}`}
                className="bg-[#161412] border border-[#2A2723] hover:border-[#E8943A] rounded-xl p-4 transition-colors block"
              >
                <p className="text-[#F5F0EB] font-medium">{b.products} товарів · {b.photos} фото</p>
                <p className="text-[#6B6560] text-xs mt-1">
                  {new Date(b.lastDate).toLocaleString("uk-UA")}
                </p>
                <div className="flex items-center gap-2 mt-2 text-xs">
                  <span className="text-green-400">✓ {b.done}</span>
                  {b.errors > 0 && <span className="text-red-400">✗ {b.errors}</span>}
                  <span className="text-[#E8943A] ml-auto">Перевірити →</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Single generations ───────────────────────────────────────── */}
      <div className="space-y-3">
        {batches.length > 0 && gens.length > 0 && (
          <h2 className="font-heading text-lg font-semibold text-[#F5F0EB]">Окремі генерації</h2>
        )}
        {gens.length === 0 && batches.length === 0 ? (
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl px-6 py-12 text-center text-[#6B6560]">
            Генерацій поки немає.{" "}
            <Link href="/dashboard/generate" className="text-[#E8943A] hover:underline">Створити першу →</Link>
          </div>
        ) : (
          <div className="space-y-4">
            {gens.map((g) => {
              const photos = (g.image_urls ?? [])
                .map((u, i) => (u ? urlByPath.get(pathFor(g.id, i)) : null))
                .filter((u): u is string => !!u);
              return (
                <div key={g.id} className="bg-[#161412] border border-[#2A2723] rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <p className="text-[#F5F0EB] font-medium">{g.brand || "—"} — {g.product_type || "—"}</p>
                      <p className="text-[#6B6560] text-xs mt-0.5">
                        {[g.season, g.gender].filter(Boolean).join(" · ")}
                        {(g.season || g.gender) && " · "}
                        {new Date(g.created_at).toLocaleString("uk-UA")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[#6B6560] text-xs">{photos.length} фото</span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        g.status === "done" ? "bg-green-500/20 text-green-400" :
                        g.status === "error" ? "bg-red-500/20 text-red-400" :
                        "bg-[#2A2723] text-[#6B6560]"
                      }`}>
                        {g.status === "done" ? "Готово" : g.status === "error" ? "Помилка" : g.status}
                      </span>
                    </div>
                  </div>
                  {photos.length > 0 ? (
                    <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                      {photos.map((url, i) => (
                        <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                           className="aspect-[3/4] rounded-lg overflow-hidden border border-[#2A2723] hover:border-[#E8943A] transition-colors block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="" className="w-full h-full object-cover" />
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[#6B6560] text-sm">Фото недоступні (генерація без успішних кадрів).</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
