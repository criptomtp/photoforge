"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const supabase = createClient();

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (password.length < 6) {
      setError("Пароль має бути не менше 6 символів");
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message === "User already registered"
        ? "Цей email вже зареєстрований"
        : error.message
      );
      setLoading(false);
    } else {
      setSuccess(true);
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

  if (success) {
    return (
      <div className="w-full max-w-md text-center">
        <div className="bg-[#161412] border border-[#2A2723] rounded-2xl p-8">
          <div className="text-4xl mb-4">✉️</div>
          <h2 className="font-heading text-2xl font-bold text-[#F5F0EB] mb-2">
            Перевір пошту
          </h2>
          <p className="text-[#6B6560]">
            Ми надіслали лист на <span className="text-[#F5F0EB]">{email}</span>.
            Підтвердь email, щоб завершити реєстрацію.
          </p>
          <Link
            href="/login"
            className="inline-block mt-6 text-[#E8943A] hover:underline text-sm"
          >
            Повернутись до входу
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-8">
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">
          Реєстрація
        </h1>
        <p className="text-[#6B6560] mt-2">5 безкоштовних генерацій щомісяця</p>
      </div>

      <div className="bg-[#161412] border border-[#2A2723] rounded-2xl p-8 space-y-6">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 bg-[#1E1C19] hover:bg-[#2A2723] border border-[#2A2723] rounded-xl py-3 text-[#F5F0EB] text-sm font-medium transition-colors disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Зареєструватись через Google
        </button>

        <div className="flex items-center gap-4">
          <div className="flex-1 h-px bg-[#2A2723]" />
          <span className="text-[#6B6560] text-xs">або</span>
          <div className="flex-1 h-px bg-[#2A2723]" />
        </div>

        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Ім&apos;я</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Іван Петренко"
              className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
            />
          </div>
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
              placeholder="Мінімум 6 символів"
              className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-50 text-[#0C0B0A] font-semibold py-3 rounded-xl transition-colors"
          >
            {loading ? "Завантаження..." : "Створити акаунт"}
          </button>
        </form>

        <p className="text-center text-sm text-[#6B6560]">
          Вже є акаунт?{" "}
          <Link href="/login" className="text-[#E8943A] hover:underline">
            Увійти
          </Link>
        </p>
      </div>
    </div>
  );
}
