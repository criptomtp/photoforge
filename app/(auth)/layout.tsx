import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0C0B0A] flex flex-col">
      <nav className="border-b border-[#2A2723] px-6 h-16 flex items-center max-w-7xl mx-auto w-full">
        <Link href="/" className="font-heading text-xl font-bold text-[#E8943A]">
          PhotoForge
        </Link>
      </nav>
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        {children}
      </div>
    </div>
  );
}
