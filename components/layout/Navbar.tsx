"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const navLinks = [
  { href: "/dashboard/generate", label: "Генерація" },
  { href: "/dashboard/batch", label: "Масова" },
  { href: "/dashboard/history", label: "Історія" },
  { href: "/pricing", label: "Тарифи" },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <nav className="border-b border-[#2A2723] bg-[#0C0B0A]/95 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="font-heading text-xl font-bold text-[#E8943A]">
            PhotoForge
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                pathname?.startsWith(link.href)
                  ? "bg-[#1E1C19] text-[#F5F0EB]"
                  : "text-[#6B6560] hover:text-[#F5F0EB] hover:bg-[#161412]"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/settings"
            className={`text-sm transition-colors ${
              pathname === "/dashboard/settings"
                ? "text-[#F5F0EB]"
                : "text-[#6B6560] hover:text-[#F5F0EB]"
            }`}
          >
            Налаштування
          </Link>
          <button
            onClick={handleLogout}
            className="bg-[#1E1C19] hover:bg-[#2A2723] border border-[#2A2723] text-[#F5F0EB] text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Вийти
          </button>
        </div>
      </div>
    </nav>
  );
}
