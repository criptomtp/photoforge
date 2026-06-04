"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { costForAngles, QUALITY_TIERS, AVAILABLE_TIERS, type QualityId } from "@/lib/angles";
import { CATEGORY_LIST, category, type CategoryId } from "@/lib/categories";

const SEASONS = ["Зима", "Осінь", "Літо", "Демісезон"];
const GENDERS = ["Чоловіча", "Жіноча", "Хлопчик", "Дівчинка", "Унісекс"];

type GenerationState =
  | { phase: "idle" }
  | { phase: "running"; status: string; current: number; total: number; urls: (string | null)[]; imageErrors: string[]; angleLabels: string[]; prompts: string[]; generationId: string }
  | { phase: "done"; generationId: string; urls: string[]; prompts: string[]; byok: boolean; driveUrl?: string; imageErrors: string[]; angleLabels: string[]; cost: number }
  | { phase: "error"; message: string };

export default function GeneratePage() {
  // ── Category (drives angle set, gender requirement, on-model vs product) ──
  const [categoryId, setCategoryId] = useState<CategoryId>("clothing");
  const cat = useMemo(() => category(categoryId), [categoryId]);

  const [productType, setProductType] = useState("");
  const [season, setSeason] = useState("");
  const [gender, setGender] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);

  // ── Angle selection ─────────────────────────────────────────────────────
  const [presetId, setPresetId] = useState<string>("full");
  const [quality, setQuality] = useState<QualityId>("standard");
  const [customAngles, setCustomAngles] = useState<string[]>(cat.presets[0].angles.slice());
  const isCustom = presetId === "custom";
  const selectedAngles = isCustom
    ? customAngles
    : (cat.presets.find((p) => p.id === presetId)?.angles.slice() ?? []);

  const cost = useMemo(
    () => costForAngles(selectedAngles.length, QUALITY_TIERS[quality].tokenMultiplier),
    [selectedAngles.length, quality]
  );

  const [state, setState] = useState<GenerationState>({ phase: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [regenIdx, setRegenIdx] = useState<number | null>(null);
  // Auto-fill: after the main batch, sequentially regenerate the slots that
  // failed (429 quota / STOP). Each is a fresh request (own time budget + a
  // single image that doesn't trip the burst quota), paced to let the per-minute
  // Vertex quota refill — gets to all photos for free on the low trial quota.
  const [autoFill, setAutoFill] = useState<{ active: boolean; done: number; total: number }>({ active: false, done: 0, total: 0 });
  const autoFilledRef = useRef<string>("");

  // Switching category swaps the entire angle set, so reset the picker to the
  // new category's full preset (old angle IDs don't exist in the new set).
  function selectCategory(id: CategoryId) {
    if (state.phase === "running") return;
    setCategoryId(id);
    setPresetId("full");
    setCustomAngles(category(id).presets[0].angles.slice());
  }

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
      const preset = cat.presets.find((p) => p.id === id);
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

    // Resolve labels in the category's canonical order to mirror the API
    const angleLabels = cat.angles.filter((a) => selectedAngles.includes(a.id)).map((a) => a.label);
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
      prompts: [],
      generationId: "",
    });

    const formData = new FormData();
    formData.append("category", categoryId);
    formData.append("productType", productType);
    formData.append("season", season);
    formData.append("gender", gender);
    images.forEach((img) => formData.append("images", img));
    // Send angles in the category's canonical order
    cat.angles.forEach((a) => {
      if (selectedAngles.includes(a.id)) formData.append("angles", a.id);
    });
    formData.append("quality", quality);

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
                  ? {
                      ...s,
                      status: `Промпти готові. Генерую ${event.count} фото паралельно...`,
                      prompts: event.prompts ?? [],
                      generationId: event.generationId ?? s.generationId,
                    }
                  : s
              );
              break;

            case "image_start":
              setState((s) =>
                s.phase === "running"
                  ? { ...s, status: `Генерую: ${event.angle}...` }
                  : s
              );
              break;

            case "image_done":
              // Parallel generation → events arrive out of order. Place by index,
              // and count completed (success or fail) for the progress bar.
              setState((s) => {
                if (s.phase !== "running") return s;
                const urls = [...s.urls];
                urls[event.index - 1] = event.url || null;
                const imageErrors = event.error
                  ? [...s.imageErrors, `Фото ${event.index}: ${event.error}`]
                  : s.imageErrors;
                return { ...s, current: s.current + 1, urls, imageErrors };
              });
              break;

            case "done":
              setState((s) => ({
                phase: "done",
                generationId: event.generationId,
                urls: event.urls,
                prompts: event.prompts ?? [],
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

      // Stream ended without a "done" event (e.g. server hit its time limit).
      // Finalize with whatever arrived so the UI never hangs.
      setState((s) => {
        if (s.phase !== "running") return s;
        const got = s.urls.filter(Boolean).length;
        return {
          phase: "done",
          generationId: s.generationId,
          urls: s.urls.map((u) => u ?? ""),
          prompts: s.prompts,
          byok: false,
          imageErrors:
            got < s.total
              ? [...s.imageErrors, `Згенеровано ${got}/${s.total}. Решту перервано (ліміт часу). Натисни «↻ Перегенерувати» на порожніх.`]
              : s.imageErrors,
          angleLabels: s.angleLabels,
          cost: 0,
        };
      });
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
        zip.file(`${label}.jpg`, blob);
      })
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${productType || cat.label}_photos.zip`;
    a.click();
  }

  async function handleRegenerate(i: number) {
    if (state.phase !== "done") return;
    const prompt = state.prompts[i];
    if (!prompt || images.length === 0) return;
    setRegenIdx(i);
    const genId = state.generationId;
    try {
      const fd = new FormData();
      fd.append("generationId", genId);
      fd.append("index", String(i));
      fd.append("prompt", prompt);
      images.forEach((img) => fd.append("images", img));
      const res = await fetch("/api/generate/regenerate", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({} as { url?: string; error?: string }));
      setState((s) => {
        if (s.phase !== "done") return s;
        if (res.ok && data.url) {
          const urls = [...s.urls];
          urls[i] = data.url;
          return { ...s, urls, imageErrors: s.imageErrors.filter((e) => !e.startsWith(`Фото ${i + 1}:`)) };
        }
        return { ...s, imageErrors: [...s.imageErrors, `Фото ${i + 1}: ${data.error ?? "не вдалося"}`] };
      });
    } catch {
      setState((s) => (s.phase === "done" ? { ...s, imageErrors: [...s.imageErrors, `Фото ${i + 1}: помилка мережі`] } : s));
    } finally {
      setRegenIdx(null);
    }
  }

  // Regenerate failed slots one-by-one, paced, as separate requests.
  async function autoFillFailed(genId: string, indices: number[], prompts: string[]) {
    setAutoFill({ active: true, done: 0, total: indices.length });
    let done = 0;
    for (const i of indices) {
      const prompt = prompts[i];
      if (prompt) {
        // Pace so the per-minute Vertex quota refills between single requests.
        await new Promise((r) => setTimeout(r, 8000));
        try {
          const fd = new FormData();
          fd.append("generationId", genId);
          fd.append("index", String(i));
          fd.append("prompt", prompt);
          images.forEach((img) => fd.append("images", img));
          const res = await fetch("/api/generate/regenerate", { method: "POST", body: fd });
          const data = await res.json().catch(() => ({} as { url?: string }));
          if (res.ok && data.url) {
            setState((s) => {
              if (s.phase !== "done") return s;
              const urls = [...s.urls];
              urls[i] = data.url!;
              return { ...s, urls, imageErrors: s.imageErrors.filter((e) => !e.startsWith(`Фото ${i + 1}:`)) };
            });
          }
        } catch { /* leave empty — manual «Перегенерувати» remains */ }
      }
      done++;
      setAutoFill((a) => ({ ...a, done }));
    }
    setAutoFill({ active: false, done: 0, total: 0 });
  }

  // When a run finishes with some empty slots, auto-fill them once.
  useEffect(() => {
    if (state.phase !== "done" || !state.generationId) return;
    if (autoFilledRef.current === state.generationId) return;
    if (images.length === 0 || state.prompts.length === 0) return;
    const empty = state.urls.map((u, i) => (u ? -1 : i)).filter((i) => i >= 0);
    // Skip if nothing failed, or EVERYTHING failed (systemic error — don't hammer).
    if (empty.length === 0 || empty.length >= state.urls.length) return;
    autoFilledRef.current = state.generationId;
    void autoFillFailed(state.generationId, empty, state.prompts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const isRunning = state.phase === "running";
  const isDone = state.phase === "done";
  const canSubmit =
    selectedAngles.length > 0 &&
    images.length > 0 &&
    productType.trim().length > 0 &&
    (!cat.needsGender || gender.trim().length > 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Генерація фото</h1>
        <p className="text-[#6B6560] mt-1">Оберіть категорію та ракурси, завантажте референс</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* ── Form ──────────────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* ── Category selector ──────────────────────────────────────── */}
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Категорія товару</label>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {CATEGORY_LIST.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => selectCategory(c.id)}
                  disabled={isRunning}
                  className={`px-2 py-2.5 rounded-lg text-xs font-medium transition-colors border flex flex-col items-center gap-1 ${
                    categoryId === c.id
                      ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]"
                      : "bg-[#161412] border-[#2A2723] text-[#6B6560] hover:border-[#E8943A] hover:text-[#F5F0EB]"
                  }`}
                >
                  <span className="text-lg leading-none">{c.emoji}</span>
                  <span className="text-center leading-tight">{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={cat.onModel ? "grid grid-cols-2 gap-4" : ""}>
            {cat.onModel && (
              <div>
                <label className="block text-sm text-[#6B6560] mb-2">
                  Стать{" "}
                  {cat.needsGender
                    ? <span className="text-[#E8943A]">*</span>
                    : <span className="text-[#6B6560]">(необов&apos;язково)</span>}
                </label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors"
                  disabled={isRunning}
                >
                  <option value="">{cat.needsGender ? "Оберіть стать" : "AI обере сам"}</option>
                  {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm text-[#6B6560] mb-2">Який товар головний? <span className="text-[#E8943A]">*</span></label>
              <input
                type="text"
                value={productType}
                onChange={(e) => setProductType(e.target.value)}
                placeholder="напр. сорочка, джинси, кросівки, каблучка"
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
                disabled={isRunning}
              />
            </div>
          </div>
          <p className="text-xs text-[#6B6560] leading-snug">
            🛈 <span className="text-[#8B857F]">Якщо на фото кілька речей</span> (напр. сорочка + джинси) — вкажи, яку саме рекламуєш. AI зробить її головною, а решту образу підбере під неї.
          </p>
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Сезон <span className="text-[#6B6560]">(необов&apos;язково)</span></label>
            <select
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors"
              disabled={isRunning}
            >
              <option value="">Без сезону (чистий каталоговий фон)</option>
              {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <p className="text-xs text-[#6B6560] leading-snug">
            🛈 <span className="text-[#8B857F]">Сезон = в якому сезоні/сцені показати товар.</span> Напр. купальник + «Зима» → купальник у зимовій сцені. Без сезону — чистий каталоговий фон. Сам товар AI визначає з фото.
          </p>

          {/* ── Angle picker ───────────────────────────────────────────── */}
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">
              Ракурси <span className="text-[#F5F0EB]">({selectedAngles.length})</span>
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {cat.presets.map((preset) => (
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
                {cat.angles.map((a) => {
                  const checked = customAngles.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                        checked ? "bg-[#E8943A]/10" : "hover:bg-[#1E1C19]"
                      }`}
                      title={a.desc}
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

          {/* Quality selector — only shown when more than one tier is available.
              Plus/Pro are disabled for now (tiny Vertex quota → 429s). */}
          {AVAILABLE_TIERS.length > 1 && (
            <div>
              <label className="block text-sm text-[#6B6560] mb-2">Якість фото</label>
              <div className="flex gap-2">
                {AVAILABLE_TIERS.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => setQuality(t.id)}
                    disabled={isRunning}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs transition-colors border text-left ${
                      quality === t.id
                        ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]"
                        : "bg-[#161412] border-[#2A2723] text-[#6B6560] hover:border-[#E8943A] hover:text-[#F5F0EB]"
                    }`}
                  >
                    <div className="font-semibold">{t.label}</div>
                    <div className="text-[10px] opacity-80 leading-tight mt-0.5">{t.desc}</div>
                    <div className="text-[10px] mt-1">×{t.tokenMultiplier} ток/фото</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Cost preview */}
          <div className="bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-sm flex items-center justify-between">
            <span className="text-[#6B6560]">
              Вартість: <span className="text-[#F5F0EB] font-medium">{cost.toFixed(2)} токенів</span>
            </span>
            <span className="text-[#6B6560] text-xs">
              {selectedAngles.length} × {(0.5 * QUALITY_TIERS[quality].tokenMultiplier).toFixed(2)} + 0.10 (промпт)
            </span>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isRunning || !canSubmit}
              className="flex-1 bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-40 disabled:cursor-not-allowed text-[#0C0B0A] font-semibold py-4 rounded-xl transition-colors"
            >
              {isRunning ? "Генерація..." : `Згенерувати ${selectedAngles.length} фото`}
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
                        : "border-[#E8943A]/40 bg-[#1E1C19] animate-pulse"
                    }`}
                  >
                    {url ? (
                      // Clickable the instant it's ready — no need to wait for the rest.
                      <a href={url} target="_blank" rel="noopener noreferrer" className="block w-full h-full" title={`${state.angleLabels[i] ?? ""} — відкрити`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={state.angleLabels[i] ?? ""} className="w-full h-full object-cover hover:scale-105 transition-transform" />
                      </a>
                    ) : (
                      <span className="text-[#6B6560]">{i + 1}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {isDone && (
            <div className="space-y-4">
              {autoFill.active && (
                <div className="bg-[#E8943A]/10 border border-[#E8943A]/30 rounded-xl px-4 py-3 text-[#E8943A] text-sm flex items-center gap-2">
                  <span className="animate-pulse">⏳</span>
                  Докручую фото, що не вийшли з першого разу… {autoFill.done}/{autoFill.total}
                </div>
              )}
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
                    <button
                      type="button"
                      onClick={() => handleRegenerate(i)}
                      disabled={regenIdx !== null || !state.prompts[i] || images.length === 0}
                      className="w-full text-[10px] text-[#6B6560] hover:text-[#E8943A] border border-[#2A2723] hover:border-[#E8943A] rounded py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {regenIdx === i ? "Генерую..." : "↻ Перегенерувати"}
                    </button>
                    {state.prompts[i] && (
                      <details className="text-[10px] text-[#6B6560]">
                        <summary className="cursor-pointer hover:text-[#E8943A] text-center">промпт</summary>
                        <p className="mt-1 text-[#8B857F] leading-snug max-h-32 overflow-auto bg-[#0C0B0A] border border-[#2A2723] rounded p-1.5 whitespace-pre-wrap">
                          {state.prompts[i]}
                        </p>
                      </details>
                    )}
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
