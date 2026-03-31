import { supabaseAdmin as admin } from "@/lib/supabase/admin";

export const revalidate = 0;

export default async function AdminUsersPage() {

  const { data: users } = await admin
    .from("admin_users_view")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Користувачі</h1>
          <p className="text-[#6B6560] mt-1">{users?.length ?? 0} зареєстровано</p>
        </div>
      </div>

      <div className="bg-[#161412] border border-[#2A2723] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#2A2723]">
                {["Email", "План", "Токени", "Генерацій", "BYOK", "Drive", "Зареєстрований"].map((h) => (
                  <th key={h} className="text-left text-[#6B6560] font-medium px-5 py-3 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!users?.length ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-[#6B6560]">
                    Немає користувачів
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="border-b border-[#2A2723]/50 hover:bg-[#1E1C19] transition-colors">
                    <td className="px-5 py-3 text-[#F5F0EB]">{u.email}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        u.plan === "pro" ? "bg-[#E8943A]/20 text-[#E8943A]" :
                        u.plan === "starter" ? "bg-blue-500/20 text-blue-400" :
                        "bg-[#2A2723] text-[#6B6560]"
                      }`}>
                        {u.plan}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[#F5F0EB] font-mono">
                      {Number(u.token_balance).toFixed(2)}
                    </td>
                    <td className="px-5 py-3 text-[#6B6560]">
                      {u.generations_done ?? 0}
                      {u.generations_error > 0 && (
                        <span className="text-red-400 ml-1">(+{u.generations_error} err)</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className={u.has_byok ? "text-green-400" : "text-[#6B6560]"}>
                        {u.has_byok ? "✓" : "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={u.google_drive_connected ? "text-green-400" : "text-[#6B6560]"}>
                        {u.google_drive_connected ? "✓" : "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-[#6B6560] text-xs whitespace-nowrap">
                      {new Date(u.created_at).toLocaleDateString("uk-UA")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
