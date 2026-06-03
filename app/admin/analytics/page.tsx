import { supabaseAdmin as admin } from "@/lib/supabase/admin";

export const revalidate = 0;

export default async function AdminAnalyticsPage() {

  const [{ data: dailyStats }, { data: totals }] = await Promise.all([
    admin
      .from("admin_analytics_view")
      .select("*")
      .limit(30),
    admin
      .from("generations")
      .select("status, images_generated")
      .then(async ({ data }) => ({
        data: {
          total: data?.length ?? 0,
          done: data?.filter((g) => g.status === "done").length ?? 0,
          error: data?.filter((g) => g.status === "error").length ?? 0,
          images: data?.reduce((s, g) => s + (g.images_generated ?? 0), 0) ?? 0,
        },
      })),
  ]);

  // Rough cost estimate — the exact billed amount is in Google Cloud Billing.
  // Prices from the 2026 council research: gemini-2.5-flash-image ≈ $0.039/image,
  // gemini-2.5-pro prompt ≈ $0.05/run.
  const IMAGE_PRICE = 0.039;
  const PROMPT_PRICE = 0.05;
  const costFor = (images: number, runs: number) => images * IMAGE_PRICE + runs * PROMPT_PRICE;
  const estimatedCost = costFor(totals?.images ?? 0, totals?.total ?? 0);

  const StatCard = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-5">
      <p className="text-[#6B6560] text-sm">{label}</p>
      <p className="font-heading text-3xl font-bold text-[#F5F0EB] mt-1">{value}</p>
      {sub && <p className="text-[#6B6560] text-xs mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Аналітика</h1>
        <p className="text-[#6B6560] mt-1">Статистика генерацій</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Всього генерацій" value={totals?.total ?? 0} />
        <StatCard label="Успішних" value={totals?.done ?? 0}
          sub={totals?.total ? `${Math.round((totals.done / totals.total) * 100)}%` : undefined} />
        <StatCard label="Помилок" value={totals?.error ?? 0} />
        <StatCard label="Фото згенеровано" value={totals?.images ?? 0} />
      </div>

      <div className="bg-gradient-to-br from-[#1E1C19] to-[#161412] border border-[#E8943A]/30 rounded-xl p-5 flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-[#6B6560] text-sm">Орієнтовна вартість (оцінка)</p>
          <p className="font-heading text-4xl font-bold text-[#E8943A] mt-1">${estimatedCost.toFixed(2)}</p>
          <p className="text-[#6B6560] text-xs mt-1">
            {totals?.images ?? 0} фото × $0.039 + {totals?.total ?? 0} промптів × $0.05
          </p>
        </div>
        <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener noreferrer"
          className="text-xs text-[#6B6560] hover:text-[#E8943A] underline">
          Точний рахунок у Google Cloud Billing →
        </a>
      </div>

      <div className="bg-[#161412] border border-[#2A2723] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#2A2723]">
          <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">Останні 30 днів</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#2A2723]">
              {["День", "Генерацій", "Успішних", "Помилок", "Фото", "Юзерів", "Вартість"].map((h) => (
                <th key={h} className="text-left text-[#6B6560] font-medium px-5 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!dailyStats?.length ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-[#6B6560]">Немає даних</td>
              </tr>
            ) : (
              dailyStats.map((row) => (
                <tr key={String(row.day)} className="border-b border-[#2A2723]/50 hover:bg-[#1E1C19] transition-colors">
                  <td className="px-5 py-3 text-[#F5F0EB] whitespace-nowrap">
                    {new Date(row.day).toLocaleDateString("uk-UA")}
                  </td>
                  <td className="px-5 py-3 text-[#F5F0EB]">{row.total_generations}</td>
                  <td className="px-5 py-3 text-green-400">{row.successful}</td>
                  <td className="px-5 py-3 text-red-400">{row.failed}</td>
                  <td className="px-5 py-3 text-[#6B6560]">{row.total_images}</td>
                  <td className="px-5 py-3 text-[#6B6560]">{row.unique_users}</td>
                  <td className="px-5 py-3 text-[#E8943A]">${costFor(row.total_images ?? 0, row.total_generations ?? 0).toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
