"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ANGLE_DEFS, PRESETS, costForAngles } from "@/lib/angles";

const SEASONS = ["Зима", "Осінь", "Літо", "Демісезон"];
const GENDERS = ["Чоловіча", "Жіноча", "Хлопчик", "Дівчинка", "Унісекс"];

type GenerationState =
  | { phase: "idle" }
  | { phase: "running"; status: string; current: number; total: number; urls: (string | null)[]; imageErrors: string[]; angleLabels: string[] }
  | { phase: "done"; generationId: string; urls: string[]; byok: boolean; driveUrl?: string; imageErrors: string[]; angleLabels: string[]; cost: number }
  | { phase: "error"; message: string };

export default function GeneratePage() {
  const [brand, setBrand] = useState("");
  const [productType, setProductType] = useState("");
  const [season, setSeason] = useState("");
  const [gender, setGender] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);

  // ── Angle selection ─────────────────────────────────────────────────────
  const [presetId, setPresetId] = useState<string>("full");
  const [customAngles, setCustomAngles] = useState<string[]>(PRESETS[0].angles.slice());
  const isCustom = presetId === "custom";
  const selectedAngles = isCustom
    ? customAngles
    : (PRESETS.find((p) => p.id === presetId)?.angles.slice() ?? []);

  const cost = useMemo(() => costForAngles(selectedAngles.length), [selectedAngles.length]);

  const [state, setState] = useState<GenerationState>({ phase: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 9);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setImages(files);
    setPreviews(files.map((f) => URL.createObjectURL(f)));
  }

  function removeImage(idx: number) {
    URL.revokeObjectURL(previews[idx]);
    setImages((prev) => prev.filter((_, i) => i !== idx));
    setPreviews((prev) => prev.filter((_, i) => i !== idx));
  }

  function selectPreset(id: string) {
    setPresetId(id);
    if (id !== "custom") {
      const preset = PRESETS.find((p) => p.id === id);
      if (preset) setCustomAngles(preset.angles.slice());
    }
  }

  function toggleCustomAngle(angleId: string) {
    setPresetId("custom");
    setCustomAngles((prev) =>
      prev.includes(angleId) ? prev.filter((id) => id !== angleId) : [...prev, angleId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (selectedAngles.length === 0) return;

    // Resolve labels in canonical order to mirror the API
    const angleLabels = ANGLE_DEFS.filter((a) => selectedAngles.includes(a.id)).map((a) => a.label);
    const N = angleLabels.length;

    abortRef.current = new AbortController();
    setState({
      phase: "running",
      status: "Підготовка...",
      current: 0,
      total: N,
      urls: Array(N).fill(null),
      imageErrors: [],
      angleLabels,
    });

    const formData = new FormData();
    formData.append("brand", brand);
    formData.append("productType", productType);
    formData.append("season", season);
    formData.append("gender", gender);
    images.forEach((img) => formData.append("images", img));
    // Send angles in canonical order
    ANGLE_DEFS.forEach((a) => {
      if (selectedAngles.includes(a.id)) formData.append("angles", a.id);
    });

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        body: formData,
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        setState({ phase: "error", message: `HTTP ${res.status}` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          switch (event.type) {
            case "status":
              setState((s) =>
                s.phase === "running" ? { ...s, status: event.message } : s
              );
              break;

            case "prompts_ready":
              setState((s) =>
                s.phase === "running"
                  ? { ...s, status: `Промпти готові. Генерую ${event.count} зображень...` }
                  : s
              );
              break;

            case "image_start":
              setState((s) =>
                s.phase === "running"
                  ? { ...s, status: `Генерую ${event.index}/${event.total}: ${event.angle}...`, current: event.index - 1 }
                  : s
              );
              break;

            case "image_done":
              setState((s) => {
                if (s.phase !== "running") return s;
                const urls = [...s.urls];
                urls[event.index - 1] = event.url || null;
                const imageErrors = event.error
                  ? [...s.imageErrors, `Фото ${event.index}: ${event.error}`]
                  : s.imageErrors;
                return { ...s, current: event.index, urls, imageErrors };
              });
              break;

            case "done":
              setState((s) => ({
                phase: "done",
                generationId: event.generationId,
                urls: event.urls,
                byok: event.byok,
                driveUrl: event.driveUrl,
                imageErrors: s.phase === "running" ? s.imageErrors : [],
                angleLabels: s.phase === "running" ? s.angleLabels : angleLabels,
                cost: event.cost ?? 0,
              }));
              break;

            case "error":
              setState({ phase: "error", message: event.message });
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setState({ phase: "error", message: (err as Error).message });
      }
    }
  }

  function handleReset() {
    abortRef.current?.abort();
    setState({ phase: "idle" });
  }

  async function handleDownloadZip() {
    if (state.phase !== "done") return;
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    await Promise.all(
      state.urls.map(async (url, i) => {
        if (!url) return;
        const res = await fetch(url);
        const blob = await res.blob();
        const label = state.angleLabels[i]?.replace(/ /g, "_") ?? `angle_${i + 1}`;
        zip.file(`${brand}_${label}.jpg`, blob);
      })
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${brand}_${productType}_photos.zip`;
    a.click();
  }

  const isRunning = state.phase === "running";
  const isDone = state.phase === "done";
  const canSubmit = selectedAngles.length > 0 && images.length > 0 && brand.trim() && productType.trim();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Генерація фото</h1>
        <p className="text-[#6B6560] mt-1">Оберіть ракурси, заповніть форму та завантажте референс</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* ── Form ──────────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-[#6B6560] mb-2">Бренд</label>
              <input
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Nike, Zara, H&M..."
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
                disabled={isRunning}
              />
            </div>
            <div>
              <label className="block text-sm text-[#6B6560] mb-2">Вид товару</label>
              <input
                type="text"
                value={productType}
                onChange={(e) => setProductType(e.target.value)}
                placeholder="Пуховик, кросівки..."
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
                disabled={isRunning}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-[#6B6560] mb-2">Сезонність</label>
              <select
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors"
                disabled={isRunning}
              >
                <option value="">Оберіть сезон</option>
                {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-[#6B6560] mb-2">Стать</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors"
                disabled={isRunning}
              >
                <option value="">Оберіть стать</option>
                {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>

          {/* ── Angle picker ───────────────────────────────────────────── */}
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">
              Ракурси <span className="text-[#F5F0EB]">({selectedAngles.length})</span>
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  onClick={() => selectPreset(preset.id)}
                  disabled={isRunning}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                    presetId === preset.id
                      ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]"
                      : "bg-[#161412] border-[#2A2723] text-[#6B6560] hover:border-[#E8943A] hover:text-[#F5F0EB]"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => selectPreset("custom")}
                disabled={isRunning}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  isCustom
                    ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]"
                    : "bg-[#161412] border-[#2A2723] text-[#6B6560] hover:border-[#E8943A] hover:text-[#F5F0EB]"
                }`}
              >
                Custom...
              </button>
            </div>

            {isCustom && (
              <div className="grid grid-cols-2 gap-2 bg-[#161412] border border-[#2A2723] rounded-lg p-3">
                {ANGLE_DEFS.map((a) => {
                  const checked = customAngles.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                        checked ? "bg-[#E8943A]/10" : "hover:bg-[#1E1C19]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCustomAngle(a.id)}
                        disabled={isRunning}
                        className="mt-1 accent-[#E8943A]"
                      />
                      <span className={`text-xs ${checked ? "text-[#F5F0EB]" : "text-[#6B6560]"}`}>
                        {a.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Image upload */}
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">
              Референс-фото (до 9 зображень)
            </label>
            <div
              onClick={() => !isRunning && fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
                isRunning
                  ? "border-[#2A2723] opacity-50 cursor-not-allowed"
                  : "border-[#2A2723] hover:border-[#E8943A] cursor-pointer"
              }`}
            >
              <p className="text-[#6B6560] text-sm">Натисніть або перетягніть фото сюди</p>
              <p className="text-[#6B6560] text-xs mt-1">PNG, JPG до 10MB кожне</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleImageChange}
            />
            {previews.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mt-3">
                {previews.map((src, idx) => (
                  <div key={idx} className="relative group aspect-square">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" className="w-full h-full object-cover rounded-lg border border-[#2A2723]" />
                    {!isRunning && (
                      <button
                        type="button"
                        onClick={() => removeImage(idx)}
                        className="absolute top-1 right-1 bg-black/70 text-white rounded-full w-5 h-5 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {state.phase === "error" && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
              {state.message}
            </div>
          )}

          {/* Cost preview */}
          <div className="bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-sm flex items-center justify-between">
            <span className="text-[#6B6560]">
              Вартість: <span className="text-[#F5F0EB] font-medium">{cost.toFixed(2)} токенів</span>
            </span>
            <span className="text-[#6B6560] text-xs">
              {selectedAngles.length} × 0.50 + 0.10 (промпт)
            </span>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isRunning || !canSubmit}
              className="flex-1 bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-40 disabled:cursor-not-allowed text-[#0C0B0A] font-semibold py-4 rounded-xl transition-colors"
            >
              {isRunning
                ? "Генерація..."
                : `Згенерувати ${selectedAngles.length} ${selectedAngles.length === 1 ? "фото" : "фото"}`}
            </button>
            {isRunning && (
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-4 border border-[#2A2723] hover:border-red-500/50 text-[#6B6560] hover:text-red-400 rounded-xl transition-colors text-sm"
              >
                Скасувати
              </button>
            )}
          </div>
        </form>

        {/* ── Progress & Results ─────────────────────────────────────────── */}
        <div className="space-y-4">
          {isRunning && (
            <div className="space-y-4">
              <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[#F5F0EB] text-sm font-medium">{state.status}</p>
                  <span className="text-[#6B6560] text-xs">{state.current}/{state.total}</span>
                </div>
                <div className="w-full bg-[#2A2723] rounded-full h-1.5">
                  <div
                    className="bg-[#E8943A] h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${(state.current / state.total) * 100}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {state.urls.map((url, i) => (
                  <div
                    key={i}
                    className={`aspect-[3/4] rounded-lg border flex items-center justify-center text-xs transition-all ${
                      url
                        ? "border-[#E8943A]/30 overflow-hidden"
                        : i === state.current
                        ? "border-[#E8943A] bg-[#1E1C19] animate-pulse"
                        : "border-[#2A2723] bg-[#161412]"
                    }`}
                  >
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt={state.angleLabels[i] ?? ""} className="w-full h-full object-cover" />
                    ) : (
                      <span className={i === state.current ? "text-[#E8943A]" : "text-[#6B6560]"}>
                        {i + 1}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {isDone && (
            <div className="space-y-4">
              {state.imageErrors.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 space-y-1">
                  <p className="text-red-400 text-sm font-medium">Помилки генерації:</p>
                  {state.imageErrors.slice(0, 2).map((e, i) => (
                    <p key={i} className="text-red-400/80 text-xs font-mono break-all">{e}</p>
                  ))}
                  {state.imageErrors.length > 2 && (
                    <p className="text-red-400/60 text-xs">+{state.imageErrors.length - 2} ще...</p>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="text-[#F5F0EB] font-medium">
                    ✓ {state.urls.filter(Boolean).length} фото згенеровано
                  </p>
                  <div className="flex gap-2 mt-1 flex-wrap items-center">
                    {state.byok ? (
                      <span className="text-[10px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded">BYOK — без списання</span>
                    ) : state.cost > 0 ? (
                      <span className="text-[10px] bg-[#E8943A]/20 text-[#E8943A] px-2 py-0.5 rounded">
                        Списано {state.cost.toFixed(2)} токенів
                      </span>
                    ) : (
                      <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">Free quota</span>
                    )}
                    {state.driveUrl && (
                      <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">Drive ✓</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleDownloadZip}
                    className="bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    ZIP
                  </button>
                  {state.driveUrl && (
                    <a
                      href={state.driveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="border border-blue-500/30 hover:border-blue-400 text-blue-400 text-sm px-4 py-2 rounded-lg transition-colors"
                    >
                      Drive →
                    </a>
                  )}
                  <Link
                    href="/dashboard/history"
                    className="border border-[#2A2723] hover:border-[#E8943A] text-[#F5F0EB] text-sm px-4 py-2 rounded-lg transition-colors"
                  >
                    Історія
                  </Link>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {state.urls.map((url, i) => (
                  <div key={i} className="space-y-1">
                    <div className="aspect-[3/4] rounded-lg overflow-hidden border border-[#2A2723]">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={state.angleLabels[i] ?? ""}
                            className="w-full h-full object-cover hover:scale-105 transition-transform"
                          />
                        </a>
                      ) : (
                        <div className="w-full h-full bg-[#161412] flex items-center justify-center text-[#6B6560] text-xs">
                          Помилка
                        </div>
                      )}
                    </div>
                    <p className="text-[#6B6560] text-xs text-center truncate">{state.angleLabels[i]}</p>
                  </div>
                ))}
              </div>

              <button
                onClick={handleReset}
                className="w-full border border-[#2A2723] hover:border-[#E8943A] text-[#6B6560] hover:text-[#F5F0EB] py-3 rounded-xl transition-colors text-sm"
              >
                Нова генерація
              </button>
            </div>
          )}

          {state.phase === "idle" && (
            <div className="border border-dashed border-[#2A2723] rounded-xl p-8 text-center">
              <p className="text-[#6B6560] text-sm">
                Заповніть форму зліва та натисніть<br />
                <span className="text-[#F5F0EB]">&quot;Згенерувати&quot;</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
