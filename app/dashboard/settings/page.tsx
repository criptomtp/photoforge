"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Suspense } from "react";
import { GoogleIcon } from "@/components/icons/GoogleIcon";

interface UserProfile {
  email: string;
  full_name: string | null;
  plan: string;
  token_balance: number;
  generations_used: number;
  generations_limit: number;
  google_drive_connected: boolean;
  google_sheets_connected: boolean;
  has_gemini_key: boolean;
}

interface Transaction {
  id: string;
  amount: number;
  kind: string;
  description: string;
  balance_after: number;
  created_at: string;
}

function SettingsContent() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [geminiKey, setGeminiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const supabase = createClient();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Show success/error from Google OAuth redirect
    const connected = searchParams.get("google_connected");
    const gErr = searchParams.get("google_error");
    if (connected) setMsg({ type: "ok", text: "Google Drive та Sheets підключено!" });
    if (gErr) setMsg({ type: "err", text: `Помилка підключення Google: ${gErr}` });
    loadData();
  }, []);

  const loadData = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [{ data: p }, { data: txs }] = await Promise.all([
      supabase
        .from("profiles")
        .select("email:id, full_name, plan, token_balance, generations_used, generations_limit, google_drive_connected, google_sheets_connected, gemini_api_key")
        .eq("id", user.id)
        .single(),
      supabase
        .from("token_transactions")
        .select("id, amount, kind, description, balance_after, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    if (p) {
      setProfile({
        email: user.email ?? "",
        full_name: p.full_name,
        plan: p.plan,
        token_balance: Number(p.token_balance),
        generations_used: p.generations_used,
        generations_limit: p.generations_limit,
        google_drive_connected: p.google_drive_connected,
        google_sheets_connected: p.google_sheets_connected,
        has_gemini_key: !!p.gemini_api_key,
      });
    }
    setTransactions(txs ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleGoogleConnect() {
    setGoogleLoading(true);
    window.location.href = "/api/auth/google";
  }

  async function handleGoogleDisconnect() {
    setGoogleLoading(true);
    await fetch("/api/auth/google/disconnect", { method: "POST" });
    await loadData();
    setGoogleLoading(false);
    setMsg({ type: "ok", text: "Google відключено" });
  }

  async function handleSaveGeminiKey(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);

    const res = await fetch("/api/user/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gemini_api_key: geminiKey.trim() || null }),
    });
    const data = await res.json();
    setSaving(false);

    if (res.ok) {
      setMsg({ type: "ok", text: geminiKey.trim() ? "Gemini API ключ збережено" : "Ключ видалено" });
      setGeminiKey("");
      await loadData();
    } else {
      setMsg({ type: "err", text: data.error ?? "Помилка" });
    }
  }

  if (!profile) {
    return <div className="text-[#6B6560] animate-pulse">Завантаження...</div>;
  }

  const SectionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 space-y-4">
      <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">{title}</h2>
      {children}
    </div>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Налаштування</h1>
        <p className="text-[#6B6560] mt-1">Профіль, інтеграції, API ключі</p>
      </div>

      {/* Profile */}
      <SectionCard title="Профіль">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[#6B6560]">Email</span>
            <span className="text-[#F5F0EB]">{profile.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#6B6560]">Ім&apos;я</span>
            <span className="text-[#F5F0EB]">{profile.full_name ?? "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#6B6560]">План</span>
            <span className="text-[#E8943A] font-medium capitalize">{profile.plan}</span>
          </div>
        </div>
      </SectionCard>

      {/* Token balance */}
      <SectionCard title="Баланс токенів">
        <div className="flex items-end justify-between">
          <div>
            <p className="font-heading text-4xl font-bold text-[#F5F0EB]">
              {profile.token_balance.toFixed(2)}
            </p>
            <p className="text-[#6B6560] text-sm mt-1">токенів (~{Math.floor(profile.token_balance / 4.1)} повних генерацій)</p>
          </div>
          <div className="text-right text-sm text-[#6B6560]">
            <p>{profile.generations_used} / {profile.generations_limit} генерацій</p>
            <p className="text-xs mt-0.5">цього місяця</p>
          </div>
        </div>

        {/* Transactions */}
        {transactions.length > 0 && (
          <div className="border-t border-[#2A2723] pt-4 space-y-2">
            <p className="text-[#6B6560] text-xs uppercase tracking-wider">Остання активність</p>
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-[#F5F0EB]">{tx.description}</span>
                  <span className="text-[#6B6560] text-xs ml-2">
                    {new Date(tx.created_at).toLocaleDateString("uk-UA")}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={tx.amount >= 0 ? "text-green-400" : "text-red-400"}>
                    {tx.amount >= 0 ? "+" : ""}{tx.amount.toFixed(2)}
                  </span>
                  <span className="text-[#6B6560] text-xs w-12 text-right">
                    {Number(tx.balance_after).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Gemini BYOK */}
      <SectionCard title="Gemini API Key (BYOK)">
        <p className="text-[#6B6560] text-sm">
          Додай власний Gemini API ключ — генерації будуть безкоштовними (не списуються токени).
        </p>
        <div className="flex items-center gap-3 text-sm">
          <div className={`w-2 h-2 rounded-full ${profile.has_gemini_key ? "bg-green-400" : "bg-[#2A2723]"}`} />
          <span className={profile.has_gemini_key ? "text-green-400" : "text-[#6B6560]"}>
            {profile.has_gemini_key ? "Власний ключ підключено" : "Не підключено — використовується платформний ключ"}
          </span>
        </div>
        <form onSubmit={handleSaveGeminiKey} className="flex gap-3">
          <input
            type="password"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
            placeholder={profile.has_gemini_key ? "Введи новий ключ або залиш пустим для видалення" : "AIza..."}
            className="flex-1 bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-2.5 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors text-sm font-mono"
          />
          <button
            type="submit"
            disabled={saving}
            className="bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-50 text-[#0C0B0A] font-medium px-5 py-2.5 rounded-lg transition-colors text-sm whitespace-nowrap"
          >
            {saving ? "..." : profile.has_gemini_key ? "Оновити" : "Зберегти"}
          </button>
          {profile.has_gemini_key && (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setGeminiKey("");
                fetch("/api/user/settings", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ gemini_api_key: null }),
                }).then(() => loadData());
              }}
              className="border border-[#2A2723] hover:border-red-500/50 text-[#6B6560] hover:text-red-400 px-4 py-2.5 rounded-lg transition-colors text-sm"
            >
              Видалити
            </button>
          )}
        </form>

        {msg && (
          <div className={`rounded-lg px-4 py-2.5 text-sm ${
            msg.type === "ok"
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-red-500/10 border border-red-500/20 text-red-400"
          }`}>
            {msg.text}
          </div>
        )}

        <p className="text-[#6B6560] text-xs">
          Отримай ключ на{" "}
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer"
            className="text-[#E8943A] hover:underline">
            aistudio.google.com
          </a>
        </p>
      </SectionCard>

      {/* Google OAuth */}
      <SectionCard title="Google Інтеграції">
        <p className="text-[#6B6560] text-sm">
          Одне підключення дає доступ до Drive (автозбереження фото) та Sheets (масова генерація).
        </p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${profile.google_drive_connected ? "bg-green-400" : "bg-[#2A2723]"}`} />
            <div>
              <p className="text-[#F5F0EB] text-sm font-medium">
                {profile.google_drive_connected ? "Google підключено" : "Google не підключено"}
              </p>
              <p className="text-[#6B6560] text-xs mt-0.5">
                {profile.google_drive_connected
                  ? "Drive + Sheets активні — фото зберігаються автоматично"
                  : "Drive та Sheets недоступні"}
              </p>
            </div>
          </div>

          {profile.google_drive_connected ? (
            <button
              onClick={handleGoogleDisconnect}
              disabled={googleLoading}
              className="border border-[#2A2723] hover:border-red-500/50 text-[#6B6560] hover:text-red-400 text-xs px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              {googleLoading ? "..." : "Відключити"}
            </button>
          ) : (
            <button
              onClick={handleGoogleConnect}
              disabled={googleLoading}
              className="flex items-center gap-2 bg-white hover:bg-gray-100 text-gray-800 text-xs font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <GoogleIcon size={14} />
              {googleLoading ? "Завантаження..." : "Підключити Google"}
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="text-[#6B6560] animate-pulse">Завантаження...</div>}>
      <SettingsContent />
    </Suspense>
  );
}
