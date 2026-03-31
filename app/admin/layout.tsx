import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ADMIN_EMAIL } from "@/lib/constants";

const adminLinks = [
  { href: "/admin/settings", label: "⚙️ Налаштування платформи" },
  { href: "/admin/users", label: "👥 Користувачі" },
  { href: "/admin/analytics", label: "📊 Аналітика" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.email !== ADMIN_EMAIL) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[#0C0B0A] flex">
      {/* Sidebar */}
      <aside className="w-56 border-r border-[#2A2723] flex flex-col shrink-0">
        <div className="h-16 border-b border-[#2A2723] flex items-center px-5">
          <Link href="/admin" className="font-heading text-lg font-bold text-[#E8943A]">
            PhotoForge
          </Link>
          <span className="ml-2 text-[10px] bg-[#E8943A]/20 text-[#E8943A] px-1.5 py-0.5 rounded font-medium tracking-wide">
            ADMIN
          </span>
        </div>
        <nav className="flex-1 py-4 px-2 space-y-1">
          {adminLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="block px-3 py-2.5 rounded-lg text-sm text-[#6B6560] hover:text-[#F5F0EB] hover:bg-[#161412] transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-[#2A2723]">
          <Link
            href="/dashboard"
            className="block text-center text-xs text-[#6B6560] hover:text-[#F5F0EB] transition-colors py-2"
          >
            ← Dashboard
          </Link>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
