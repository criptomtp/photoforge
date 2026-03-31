"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleIcon } from "@/components/icons/GoogleIcon";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    searchParams.get("error") ? "Помилка авторизації. Спробуйте ще раз." : null
  );

  const supabase = createClient();

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message === "Invalid login credentials"
        ? "Невірний email або пароль"
        : error.message
      );
      setLoading(false);
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  async function handleGoogleLogin() {
    setLoading(true);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  }

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-8">
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Вхід</h1>
        <p className="text-[#6B6560] mt-2">Раді бачити тебе знову</p>
      </div>

      <div className="bg-[#161412] border border-[#2A2723] rounded-2xl p-8 space-y-6">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Google OAuth */}
        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 bg-[#1E1C19] hover:bg-[#2A2723] border border-[#2A2723] rounded-xl py-3 text-[#F5F0EB] text-sm font-medium transition-colors disabled:opacity-50"
        >
          <GoogleIcon />
          Увійти через Google
        </button>

        <div className="flex items-center gap-4">
          <div className="flex-1 h-px bg-[#2A2723]" />
          <span className="text-[#6B6560] text-xs">або</span>
          <div className="flex-1 h-px bg-[#2A2723]" />
        </div>

        {/* Email form */}
        <form onSubmit={handleEmailLogin} className="space-y-4">
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-50 text-[#0C0B0A] font-semibold py-3 rounded-xl transition-colors"
          >
            {loading ? "Завантаження..." : "Увійти"}
          </button>
        </form>

        <p className="text-center text-sm text-[#6B6560]">
          Немає акаунту?{" "}
          <Link href="/register" className="text-[#E8943A] hover:underline">
            Зареєструватись
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md h-96 bg-[#161412] rounded-2xl animate-pulse" />}>
      <LoginForm />
    </Suspense>
  );
}
