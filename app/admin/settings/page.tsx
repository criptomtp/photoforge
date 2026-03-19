"use client";

import { useEffect, useState } from "react";

interface PlatformSettings {
  gemini_api_key_masked: string;
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Налаштування платформи</h1>
        <p className="text-[#6B6560] mt-1">Gemini API ключ, вартість токенів, ціни</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Gemini API Key */}
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-6 space-y-4">
          <h2 className="font-heading text-lg font-bold text-[#F5F0EB]">Platform Gemini API Key</h2>
          <div className="bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-2.5 text-[#6B6560] text-sm font-mono">
            {settings.gemini_api_key_masked || "Не встановлено"}
          </div>
          <div>
            <label className="block text-sm text-[#6B6560] mb-1.5">Новий ключ (залиш пустим, щоб не змінювати)</label>
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="AIza..."
              className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded-lg px-4 py-2.5 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors text-sm font-mono"
            />
          </div>
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
              {(settings.cost_per_prompt_gen + settings.cost_per_image_gen * 8).toFixed(3)} токенів
            </span>
          </p>
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
