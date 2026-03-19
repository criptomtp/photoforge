"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { TOKEN_PACKS, SUBSCRIPTION_PLANS } from "@/lib/stripe";

interface Profile {
  plan: string;
  token_balance: number;
  generations_used: number;
  generations_limit: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

function TokensContent() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const searchParams = useSearchParams();
  const supabase = createClient();

  useEffect(() => {
    if (searchParams.get("success")) setMsg({ type: "ok", text: "Оплата успішна! Токени нараховано." });
    if (searchParams.get("canceled")) setMsg({ type: "err", text: "Оплату скасовано." });
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("profiles")
      .select("plan, token_balance, generations_used, generations_limit, stripe_customer_id, stripe_subscription_id")
      .eq("id", user.id)
      .single();
    if (data) setProfile({ ...data, token_balance: Number(data.token_balance) });
  }

  async function handleCheckout(priceId: string, mode: "payment" | "subscription") {
    if (!priceId) {
      setMsg({ type: "err", text: "Ціновий план не налаштований адміністратором." });
      return;
    }
    setLoading(priceId);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceId, mode }),
    });
    const data = await res.json();
    setLoading(null);
    if (data.url) window.location.href = data.url;
    else setMsg({ type: "err", text: data.error ?? "Помилка" });
  }

  async function handlePortal() {
    setLoading("portal");
    const res = await fetch("/api/billing/portal", { method: "POST" });
    const data = await res.json();
    setLoading(null);
    if (data.url) window.location.href = data.url;
    else setMsg({ type: "err", text: data.error ?? "Помилка" });
  }

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Баланс та оплата</h1>
          <p className="text-[#6B6560] mt-1">Токени, підписки та поповнення</p>
        </div>
        {profile?.stripe_customer_id && (
          <button
            onClick={handlePortal}
            disabled={loading === "portal"}
            className="border border-[#2A2723] hover:border-[#E8943A] text-[#6B6560] hover:text-[#F5F0EB] text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {loading === "portal" ? "..." : "Управляти підпискою →"}
          </button>
        )}
      </div>

      {msg && (
        <div className={`rounded-xl px-5 py-4 text-sm ${
          msg.type === "ok"
            ? "bg-green-500/10 border border-green-500/20 text-green-400"
            : "bg-red-500/10 border border-red-500/20 text-red-400"
        }`}>
          {msg.text}
        </div>
      )}

      {/* Current balance */}
      {profile && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-5">
            <p className="text-[#6B6560] text-sm">Токени</p>
            <p className="font-heading text-4xl font-bold text-[#F5F0EB] mt-1">
              {profile.token_balance.toFixed(1)}
            </p>
            <p className="text-[#6B6560] text-xs mt-1">
              ≈ {Math.floor(profile.token_balance / 4.1)} повних генерацій
            </p>
          </div>
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-5">
            <p className="text-[#6B6560] text-sm">Поточний план</p>
            <p className="font-heading text-2xl font-bold text-[#E8943A] mt-1 capitalize">
              {profile.plan}
            </p>
            {profile.stripe_subscription_id && (
              <p className="text-[#6B6560] text-xs mt-1">Підписка активна</p>
            )}
          </div>
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-5">
            <p className="text-[#6B6560] text-sm">Генерацій цього місяця</p>
            <p className="font-heading text-4xl font-bold text-[#F5F0EB] mt-1">
              {profile.generations_used}
            </p>
            <p className="text-[#6B6560] text-xs mt-1">з {profile.generations_limit} доступних</p>
          </div>
        </div>
      )}

      {/* Token packs */}
      <div>
        <h2 className="font-heading text-xl font-bold text-[#F5F0EB] mb-4">Поповнити токени</h2>
        <div className="grid grid-cols-3 gap-4">
          {TOKEN_PACKS.map((pack) => (
            <div
              key={pack.id}
              className={`bg-[#161412] border rounded-xl p-6 flex flex-col relative ${
                pack.popular ? "border-[#E8943A]" : "border-[#2A2723]"
              }`}
            >
              {pack.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#E8943A] text-[#0C0B0A] text-[10px] font-bold px-3 py-1 rounded-full tracking-wide">
                  ПОПУЛЯРНЕ
                </span>
              )}
              <p className="text-[#6B6560] text-sm">{pack.label}</p>
              <p className="font-heading text-3xl font-bold text-[#F5F0EB] mt-1">
                ${pack.usd}
              </p>
              <div className="mt-3 space-y-1.5 flex-1 text-sm text-[#6B6560]">
                <p><span className="text-[#E8943A] font-medium">{pack.tokens}</span> токенів</p>
                <p>≈ {pack.generations} повних генерацій</p>
                <p>${(pack.usd / pack.tokens).toFixed(2)} за токен</p>
              </div>
              <button
                onClick={() => handleCheckout(pack.priceId, "payment")}
                disabled={!!loading}
                className={`mt-5 w-full py-3 rounded-lg font-medium text-sm transition-colors disabled:opacity-50 ${
                  pack.popular
                    ? "bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A]"
                    : "border border-[#2A2723] hover:border-[#E8943A] text-[#F5F0EB]"
                }`}
              >
                {loading === pack.priceId ? "Завантаження..." : `Купити за $${pack.usd}`}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Subscription plans */}
      <div>
        <h2 className="font-heading text-xl font-bold text-[#F5F0EB] mb-1">Підписки</h2>
        <p className="text-[#6B6560] text-sm mb-4">Щомісячне поповнення токенів + розширені функції</p>
        <div className="grid grid-cols-2 gap-4">
          {SUBSCRIPTION_PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`bg-[#161412] border rounded-xl p-6 flex flex-col ${
                profile?.plan === plan.id ? "border-[#E8943A]" : "border-[#2A2723]"
              }`}
            >
              {profile?.plan === plan.id && (
                <span className="text-[#E8943A] text-xs font-medium mb-2">✓ Активна підписка</span>
              )}
              <div className="flex items-end gap-1 mb-4">
                <p className="font-heading text-3xl font-bold text-[#F5F0EB]">${plan.usd}</p>
                <p className="text-[#6B6560] text-sm mb-1">/міс</p>
              </div>
              <ul className="space-y-1.5 flex-1 text-sm text-[#6B6560] mb-5">
                <li><span className="text-[#E8943A]">{plan.tokensPerMonth}</span> токенів/міс</li>
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2"><span className="text-[#E8943A]">✓</span>{f}</li>
                ))}
              </ul>
              <button
                onClick={() => handleCheckout(plan.priceId, "subscription")}
                disabled={!!loading || profile?.plan === plan.id}
                className="w-full py-3 rounded-lg font-medium text-sm transition-colors disabled:opacity-50 bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A]"
              >
                {loading === plan.priceId ? "..." :
                  profile?.plan === plan.id ? "Активна" : `Підписатись за $${plan.usd}/міс`}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function TokensPage() {
  return (
    <Suspense fallback={<div className="text-[#6B6560] animate-pulse">Завантаження...</div>}>
      <TokensContent />
    </Suspense>
  );
}
