import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function HistoryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: generations } = user
    ? await supabase
        .from("generations")
        .select("id, brand, product_type, season, gender, status, images_generated, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50)
    : { data: [] };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Історія генерацій</h1>
        <p className="text-[#6B6560] mt-1">Всі ваші згенеровані фото</p>
      </div>

      <div className="bg-[#161412] border border-[#2A2723] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#2A2723]">
              {["Товар", "Сезон", "Аудиторія", "Дата", "Фото", "Статус"].map((h) => (
                <th key={h} className="text-left text-[#6B6560] font-medium px-6 py-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!generations?.length ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-[#6B6560]">
                  Генерацій поки немає.{" "}
                  <Link href="/dashboard/generate" className="text-[#E8943A] hover:underline">
                    Створити першу →
                  </Link>
                </td>
              </tr>
            ) : (
              generations.map((g) => (
                <tr key={g.id} className="border-b border-[#2A2723]/50 hover:bg-[#1E1C19] transition-colors">
                  <td className="px-6 py-4 text-[#F5F0EB]">
                    {g.brand} — {g.product_type}
                  </td>
                  <td className="px-6 py-4 text-[#6B6560]">{g.season || "—"}</td>
                  <td className="px-6 py-4 text-[#6B6560]">{g.gender || "—"}</td>
                  <td className="px-6 py-4 text-[#6B6560] whitespace-nowrap">
                    {new Date(g.created_at).toLocaleDateString("uk-UA")}
                  </td>
                  <td className="px-6 py-4 text-[#F5F0EB]">{g.images_generated ?? 0}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      g.status === "done" ? "bg-green-500/20 text-green-400" :
                      g.status === "error" ? "bg-red-500/20 text-red-400" :
                      "bg-[#2A2723] text-[#6B6560]"
                    }`}>
                      {g.status === "done" ? "Готово" : g.status === "error" ? "Помилка" : g.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
