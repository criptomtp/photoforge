import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let plan = "free";
  let generationsUsed = 0;
  let generationsLimit = 5;
  let totalPhotos = 0;

  if (user) {
    const [{ data: profile }, { data: stats }] = await Promise.all([
      supabase
        .from("profiles")
        .select("plan, generations_used, generations_limit")
        .eq("id", user.id)
        .single(),
      supabase
        .from("generations")
        .select("images_generated")
        .eq("user_id", user.id)
        .eq("status", "done"),
    ]);

    if (profile) {
      plan = profile.plan;
      generationsUsed = profile.generations_used;
      generationsLimit = profile.generations_limit;
    }
    totalPhotos = stats?.reduce((s, g) => s + (g.images_generated ?? 0), 0) ?? 0;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">
          Dashboard
        </h1>
        <p className="text-[#6B6560] mt-1">Ласкаво просимо до PhotoForge</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6">
          <p className="text-[#6B6560] text-sm">Генерацій цього місяця</p>
          <p className="font-heading text-4xl font-bold text-[#F5F0EB] mt-2">{generationsUsed}</p>
          <p className="text-[#6B6560] text-sm mt-1">з {generationsLimit} доступних ({plan})</p>
        </div>
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6">
          <p className="text-[#6B6560] text-sm">Фото згенеровано</p>
          <p className="font-heading text-4xl font-bold text-[#F5F0EB] mt-2">{totalPhotos}</p>
        </div>
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6">
          <p className="text-[#6B6560] text-sm">Поточний план</p>
          <p className="font-heading text-2xl font-bold text-[#E8943A] mt-2 capitalize">{plan}</p>
          <Link href="/pricing" className="text-sm text-[#E8943A] hover:underline mt-1 block">
            Оновити →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/dashboard/generate"
          className="bg-[#161412] border border-[#2A2723] hover:border-[#E8943A] rounded-xl p-8 transition-colors group"
        >
          <div className="text-3xl mb-4">📸</div>
          <h2 className="font-heading text-xl font-bold text-[#F5F0EB] group-hover:text-[#E8943A] transition-colors">
            Генерація фото
          </h2>
          <p className="text-[#6B6560] text-sm mt-2">
            Завантажте референс та отримайте 8 фото різних ракурсів
          </p>
        </Link>
        <Link
          href="/dashboard/batch"
          className="bg-[#161412] border border-[#2A2723] hover:border-[#E8943A] rounded-xl p-8 transition-colors group"
        >
          <div className="text-3xl mb-4">📊</div>
          <h2 className="font-heading text-xl font-bold text-[#F5F0EB] group-hover:text-[#E8943A] transition-colors">
            Масова генерація
          </h2>
          <p className="text-[#6B6560] text-sm mt-2">
            Google Sheets або Excel — генеруйте сотні товарів одразу
          </p>
        </Link>
      </div>
    </div>
  );
}
