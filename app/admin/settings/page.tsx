"use client";

import { useEffect, useState } from "react";

interface PlatformSettings {
  gemini_api_key_masked: string;
  vertex_ai_active: boolean;
  cost_per_prompt_gen: number;
  cost_per_image_gen: number;
  free_plan_tokens: number;
  pricing_starter_usd: number;
  pricing_pro_usd: number;
  maintenance_mode: boolean;
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings").then((r) => r.json()).then((d) => {
      setSettings(d);
    });
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const body: Record<string, unknown> = { ...settings };
    if (geminiKey.trim()) body.gemini_api_key = geminiKey.trim();

    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setSaving(false);
    if (res.ok) {
      setMsg({ type: "ok", text: "Збережено" });
      setGeminiKey("");
      setSettings(data);
    } else {
      setMsg({ type: "err", text: data.error ?? "Помилка" });
    }
  }

  const Field = ({
    label, value, onChange, type = "text", step, min,
  }: {
    label: string; value: string | number; onChange: (v: string) => void;
    type?: string; step?: string; min?: string;
  }) => (
    <div>
      <label className="block text-sm text-[#6B6560] mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        step={step}
        min={min}
        className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-2.5 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors text-sm"
      />
    </div>
  );

  if (!settings) {
    return <div className="text-[#6B6560] animate-pulse">Завантаження...</div>;
  }

  // Real Gemini cost estimate (per generation run)
  const GEMINI_PRO_COST_USD = 0.026;   // ~$0.026 per prompt generation (Gemini 2.5 Pro)
  const GEMINI_FLASH_COST_USD = 0.04;  // ~$0.04 per image (Gemini 2.5 Flash Preview)
  const realCostPerRun = GEMINI_PRO_COST_USD + GEMINI_FLASH_COST_USD * 8;
  const tokenCostPerRun = settings.cost_per_prompt_gen + settings.cost_per_image_gen * 8;
  const margin = tokenCostPerRun > 0 ? ((tokenCostPerRun - realCostPerRun) / tokenCostPerRun * 100) : 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Налаштування платформи</h1>
        <p className="text-[#6B6560] mt-1">Gemini API ключ, вартість токенів, ціни</p>
      </div>

      {!settings.gemini_api_key_masked && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4 flex items-start gap-3">
          <span className="text-red-400 text-lg mt-0.5">⚠</span>
          <div>
            <p className="text-red-400 font-semibold">Platform Gemini API key не встановлено</p>
            <p className="text-red-400/70 text-sm mt-0.5">Без ключа жоден користувач не зможе генерувати фото. Додайте ключ нижче та збережіть.</p>
          </div>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Gemini API Key / Vertex AI */}
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">Gemini API — джерело</h2>
            {settings.vertex_ai_active ? (
              <span className="text-xs font-medium bg-green-500/15 text-green-400 border border-green-500/30 px-3 py-1 rounded-full">
                ✓ Vertex AI активний
              </span>
            ) : (
              <span className="text-xs font-medium bg-[#2A2723] text-[#6B6560] px-3 py-1 rounded-full">
                AI Studio
              </span>
            )}
          </div>

          {settings.vertex_ai_active ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3 text-sm text-green-400">
              Використовується Vertex AI (Service Account). $300 Google Cloud кредити застосовуються.
              Env vars: <code className="font-mono">GOOGLE_VERTEX_SA_KEY</code>, <code className="font-mono">GOOGLE_CLOUD_PROJECT</code>, <code className="font-mono">GOOGLE_CLOUD_LOCATION</code>
            </div>
          ) : (
            <>
              <div className={`bg-[#0C0B0A] border rounded-lg px-4 py-2.5 text-sm font-mono ${settings.gemini_api_key_masked ? "border-[#2A2723] text-[#6B6560]" : "border-red-500/40 text-red-400"}`}>
                {settings.gemini_api_key_masked || "❌ Не встановлено"}
              </div>
              <div>
                <label className="block text-sm text-[#6B6560] mb-1.5">Новий AI Studio ключ (залиш пустим, щоб не змінювати)</label>
                <input
                  type="password"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder="AIza..."
                  className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-2.5 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors text-sm font-mono"
                />
              </div>
              <p className="text-[#6B6560] text-xs">
                Щоб використовувати Vertex AI ($300 кредити), додай <code className="font-mono text-[#E8943A]">GOOGLE_VERTEX_SA_KEY</code> до Vercel env vars.
              </p>
            </>
          )}
        </div>

        {/* Token costs */}
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 space-y-4">
          <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">Вартість токенів</h2>
          <div className="grid grid-cols-3 gap-4">
            <Field
              label="Prompt generation (Gemini Pro)"
              value={settings.cost_per_prompt_gen}
              onChange={(v) => setSettings((s) => s && ({ ...s, cost_per_prompt_gen: Number(v) }))}
              type="number" step="0.001" min="0"
            />
            <Field
              label="Image generation (×8 per run)"
              value={settings.cost_per_image_gen}
              onChange={(v) => setSettings((s) => s && ({ ...s, cost_per_image_gen: Number(v) }))}
              type="number" step="0.001" min="0"
            />
            <Field
              label="Бонус токенів при реєстрації"
              value={settings.free_plan_tokens}
              onChange={(v) => setSettings((s) => s && ({ ...s, free_plan_tokens: Number(v) }))}
              type="number" step="0.1" min="0"
            />
          </div>
          <p className="text-[#6B6560] text-xs">
            Вартість 1 повної генерації ={" "}
            <span className="text-[#E8943A]">
              {tokenCostPerRun.toFixed(3)} токенів
            </span>
          </p>
        </div>

        {/* Cost calculator */}
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 space-y-4">
          <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">Калькулятор собівартості</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="bg-[#0C0B0A] rounded-lg p-4 space-y-1">
              <p className="text-[#6B6560]">Реальна собівартість (Gemini)</p>
              <p className="text-[#F5F0EB] text-xl font-bold">${realCostPerRun.toFixed(3)}</p>
              <p className="text-[#6B6560] text-xs">
                Pro prompt: ${GEMINI_PRO_COST_USD} + 8× Flash: ${GEMINI_FLASH_COST_USD}
              </p>
            </div>
            <div className="bg-[#0C0B0A] rounded-lg p-4 space-y-1">
              <p className="text-[#6B6560]">Ціна для користувача</p>
              <p className="text-[#E8943A] text-xl font-bold">{tokenCostPerRun.toFixed(2)} токенів</p>
              <p className="text-[#6B6560] text-xs">
                1 токен ≈ $1 (відповідно до ціни пакетів)
              </p>
            </div>
            <div className={`bg-[#0C0B0A] rounded-lg p-4 space-y-1`}>
              <p className="text-[#6B6560]">Маржа</p>
              <p className={`text-xl font-bold ${margin > 0 ? "text-green-400" : "text-red-400"}`}>
                {margin.toFixed(1)}%
              </p>
              <p className="text-[#6B6560] text-xs">
                {margin > 0 ? `Прибуток: $${(tokenCostPerRun - realCostPerRun).toFixed(3)}/ген.` : "Збиток на генерацію"}
              </p>
            </div>
          </div>
          <div className="bg-[#0C0B0A] rounded-lg p-4 space-y-2 text-xs text-[#6B6560]">
            <p className="font-medium text-[#F5F0EB]">5 безкоштовних генерацій / місяць (free план)</p>
            <p>• Собівартість на 1 юзера/міс: <span className="text-[#E8943A]">${(realCostPerRun * 5).toFixed(2)}</span></p>
            <p>• Starter план (100 ген/$29): собівартість <span className="text-[#E8943A]">${(realCostPerRun * 100).toFixed(2)}</span> → маржа <span className="text-green-400">${(29 - realCostPerRun * 100).toFixed(2)}</span></p>
            <p>• Pro план (500 ген/$79): собівартість <span className="text-[#E8943A]">${(realCostPerRun * 500).toFixed(2)}</span> → маржа <span className="text-green-400">${(79 - realCostPerRun * 500).toFixed(2)}</span></p>
          </div>
        </div>

        {/* Pricing */}
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 space-y-4">
          <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">Тарифні плани (USD)</h2>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Starter ($/міс)"
              value={settings.pricing_starter_usd}
              onChange={(v) => setSettings((s) => s && ({ ...s, pricing_starter_usd: Number(v) }))}
              type="number" step="1" min="0"
            />
            <Field
              label="Pro ($/міс)"
              value={settings.pricing_pro_usd}
              onChange={(v) => setSettings((s) => s && ({ ...s, pricing_pro_usd: Number(v) }))}
              type="number" step="1" min="0"
            />
          </div>
        </div>

        {/* Maintenance */}
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 flex items-center justify-between">
          <div>
            <p className="text-[#F5F0EB] font-medium">Maintenance Mode</p>
            <p className="text-[#6B6560] text-sm mt-0.5">Блокує всі генерації для не-адмінів</p>
          </div>
          <button
            type="button"
            onClick={() => setSettings((s) => s && ({ ...s, maintenance_mode: !s.maintenance_mode }))}
            className={`relative w-12 h-6 rounded-full transition-colors ${
              settings.maintenance_mode ? "bg-[#E8943A]" : "bg-[#2A2723]"
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                settings.maintenance_mode ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        {msg && (
          <div className={`rounded-lg px-4 py-3 text-sm ${
            msg.type === "ok"
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-red-500/10 border border-red-500/20 text-red-400"
          }`}>
            {msg.text}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-50 text-[#0C0B0A] font-semibold px-8 py-3 rounded-xl transition-colors"
        >
          {saving ? "Збереження..." : "Зберегти зміни"}
        </button>
      </form>
    </div>
  );
}
