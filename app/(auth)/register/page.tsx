"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { GoogleIcon } from "@/components/icons/GoogleIcon";

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
          <GoogleIcon />
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
