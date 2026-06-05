"use client";

import { useRef, useState } from "react";
import { CATEGORY_LIST, type CategoryId } from "@/lib/categories";

type Mode = "images" | "both" | "descriptions";
type BgChoice = "studio" | "any" | "column";

interface Row { [k: string]: unknown }
interface ColMap {
  sku?: string; product?: string; gender?: string; season?: string;
  color?: string; brand?: string; composition?: string; country?: string;
  size?: string; photos: string[];
}
interface Listing { title: string; description: string; bullets: string[]; tags: string[] }
interface ItemResult { sku?: string; urls?: string[]; done?: number; total?: number; listing?: Listing; listingError?: string; error?: string }

const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-]/g, "");
function detectCols(headers: string[]): ColMap {
  const find = (...keys: string[]) =>
    headers.find((h) => keys.some((k) => norm(h).includes(norm(k))));
  const photos = headers.filter((h) => /^(фото|photo|зображ|image)/i.test(h.trim()) && !/генер/i.test(h));
  return {
    sku: find("артикул", "sku", "код"),
    product: find("товар", "вид", "назва", "product", "name"),
    gender: find("gender", "стать", "аудитор"),
    season: find("сезон"),
    color: find("колір", "цвет", "color"),
    brand: find("бренд", "brand"),
    composition: find("склад"),
    country: find("країна", "страна", "country"),
    size: find("розмір", "размер", "size"),
    photos,
  };
}
const mapGender = (v?: string) => {
  const s = (v ?? "").toLowerCase();
  if (/жен|жін|women|female/.test(s)) return "Жіноча";
  if (/муж|чол|men|male/.test(s)) return "Чоловіча";
  if (/девоч|дівч|girl/.test(s)) return "Дівчинка";
  if (/мальч|хлопч|boy/.test(s)) return "Хлопчик";
  return "Унісекс";
};
const mapSeason = (v?: string) => {
  const s = (v ?? "").toLowerCase();
  if (/зим|winter/.test(s)) return "Зима";
  if (/осен|осін|autumn|fall/.test(s)) return "Осінь";
  if (/лет|літ|summer/.test(s)) return "Літо";
  if (/деми|демі|demi/.test(s)) return "Демісезон";
  return "any";
};
const cell = (r: Row, key?: string) => (key && r[key] != null ? String(r[key]).trim() : "");

export default function BatchPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cols, setCols] = useState<ColMap>({ photos: [] });
  const [fileName, setFileName] = useState("");

  const [categoryId, setCategoryId] = useState<CategoryId>("clothing");
  const [mode, setMode] = useState<Mode>("images");
  const [bg, setBg] = useState<BgChoice>("studio");
  const [drive, setDrive] = useState(false);

  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, ok: 0, fail: 0, total: 0, current: "" });
  const [results, setResults] = useState<Record<number, ItemResult>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [currentIdx, setCurrentIdx] = useState<number | null>(null);
  const abortRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const XLSX = await import("xlsx");
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Row>(ws, { defval: null });
    const hdrs = json.length ? Object.keys(json[0]) : [];
    const dcols = detectCols(hdrs);
    setRows(json);
    setCols(dcols);
    setPhase("idle");
    setResults({});
    // Pre-select all rows that have a photo + a product type.
    const validIdx = json
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => dcols.photos.some((p) => cell(r, p)) && cell(r, dcols.product))
      .map(({ i }) => i);
    setSelected(new Set(validIdx));
  }

  const validRows = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => cols.photos.some((p) => cell(r, p)) && (cell(r, cols.product) || mode === "descriptions"));

  const allSelected = validRows.length > 0 && validRows.every(({ i }) => selected.has(i));
  function toggleRow(i: number) {
    setSelected((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(validRows.map(({ i }) => i)));
  }

  function rowSeason(r: Row): string {
    if (bg === "studio") return "";
    if (bg === "any") return "any";
    return mapSeason(cell(r, cols.season));
  }

  async function runBatch() {
    abortRef.current = false;
    setPhase("running");
    setResults({});
    const toRun = validRows.filter(({ i }) => selected.has(i));
    setProgress({ done: 0, ok: 0, fail: 0, total: toRun.length, current: "" });
    let ok = 0, fail = 0, done = 0;

    for (const { r, i } of toRun) {
      if (abortRef.current) break;
      const sku = cell(r, cols.sku) || `row${i + 1}`;
      setCurrentIdx(i);
      setProgress((p) => ({ ...p, current: sku }));
      const photoUrls = cols.photos.map((p) => cell(r, p)).filter(Boolean);
      const payload = {
        sku,
        category: categoryId,
        productType: cell(r, cols.product),
        name: cell(r, cols.product),
        brand: cell(r, cols.brand),
        color: cell(r, cols.color),
        size: cell(r, cols.size),
        gender: mapGender(cell(r, cols.gender)),
        season: rowSeason(r),
        composition: cell(r, cols.composition),
        country: cell(r, cols.country),
        photoUrls,
        mode,
        drive,
      };
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 75000);
      let data: ItemResult;
      try {
        const res = await fetch("/api/batch/item", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ac.signal,
        });
        data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
      } catch (e) {
        data = { error: (e as Error).name === "AbortError" ? "Таймаут (понад 75с)" : (e as Error).message };
      } finally {
        clearTimeout(to);
      }
      const success = !data.error && (mode === "descriptions" ? !!data.listing : (data.done ?? 0) > 0);
      if (success) ok++; else fail++;
      setResults((prev) => ({ ...prev, [i]: data }));
      done++;
      setProgress((p) => ({ ...p, done, ok, fail }));
    }
    setCurrentIdx(null);
    setPhase("done");
  }

  async function exportResults() {
    const XLSX = await import("xlsx");
    // Neutralise spreadsheet formula injection in AI text written to cells.
    const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const validIdx = new Set(validRows.map(({ i }) => i));
    const maxImgs = Math.max(1, ...Object.values(results).map((r) => r.urls?.filter(Boolean).length ?? 0));
    const out = rows.map((r, i) => {
      const res = results[i];
      const row: Row = { ...r };
      if (res) {
        const urls = (res.urls ?? []).filter(Boolean);
        for (let k = 0; k < maxImgs; k++) row[`Згенерована картинка ${k + 1}`] = urls[k] ?? "";
        row["Статус Генерації"] = res.error
          ? `Помилка: ${res.error}`
          : (res.total ? `Оброблено (${res.done ?? urls.length}/${res.total})` : (urls.length || res.listing ? "Оброблено" : "Без результату"));
        if (res.listingError) row["AI_Опис_статус"] = `Помилка: ${res.listingError}`;
        if (res.listing) {
          row["AI_Title"] = safe(res.listing.title);
          row["AI_Опис"] = safe(res.listing.description);
          row["AI_Переваги"] = safe(res.listing.bullets.join("\n"));
          row["AI_Теги"] = safe(res.listing.tags.join(", "));
        }
      } else {
        row["Статус Генерації"] = validIdx.has(i) ? "Не оброблено (зупинено)" : "Пропущено (немає фото/типу товару)";
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.writeFile(wb, `${fileName.replace(/\.[^.]+$/, "") || "photoforge"}_generated.xlsx`);
  }

  const detected = cols.photos.length > 0 && (!!cols.product || mode === "descriptions");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">
          Масова генерація <span className="text-[10px] align-middle bg-[#E8943A]/20 text-[#E8943A] px-2 py-0.5 rounded">BETA</span>
        </h1>
        <p className="text-[#6B6560] mt-1">Завантаж Excel зі своєю вигрузкою (Артикул, Товар, Gender, Сезонність, Фото_1…N) — згенеруємо набір на кожен товар.</p>
      </div>

      <div
        onClick={() => phase !== "running" && fileRef.current?.click()}
        className="border-2 border-dashed border-[#2A2723] hover:border-[#E8943A] rounded-xl p-6 text-center cursor-pointer transition-colors"
      >
        <p className="text-[#F5F0EB] text-sm">{fileName || "Натисни, щоб завантажити .xlsx / .csv"}</p>
        <p className="text-[#6B6560] text-xs mt-1">Перший аркуш, перший рядок = заголовки колонок</p>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />

      {rows.length > 0 && (
        <>
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-4 text-xs text-[#8B857F] space-y-1">
            <p className="text-[#F5F0EB] text-sm font-medium mb-1">Розпізнано: {rows.length} рядків, {validRows.length} придатних</p>
            <p>📦 Товар: <span className="text-[#E8943A]">{cols.product ?? "—"}</span> · 👤 Gender: <span className="text-[#E8943A]">{cols.gender ?? "—"}</span> · 🗓 Сезон: <span className="text-[#E8943A]">{cols.season ?? "—"}</span> · 🎨 Колір: <span className="text-[#E8943A]">{cols.color ?? "—"}</span></p>
            <p>🖼 Фото-колонки ({cols.photos.length}): <span className="text-[#E8943A]">{cols.photos.join(", ") || "не знайдено!"}</span></p>
            {!detected && <p className="text-red-400">⚠️ Не знайдено фото-колонок або колонки товару — перевір заголовки в Excel.</p>}
          </div>

          {/* Selectable products table with live status */}
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl overflow-hidden">
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#1E1C19] text-[#6B6560] z-10">
                  <tr>
                    <th className="p-2 w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={phase === "running"} className="accent-[#E8943A]" /></th>
                    <th className="p-2 text-left font-medium">Артикул</th>
                    <th className="p-2 text-left font-medium">Товар</th>
                    <th className="p-2 text-left font-medium">Стать</th>
                    <th className="p-2 text-left font-medium">Сезон</th>
                    <th className="p-2 text-center font-medium">Фото</th>
                    <th className="p-2 text-left font-medium">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {validRows.map(({ r, i }) => {
                    const res = results[i];
                    const firstUrl = res?.urls?.find(Boolean);
                    const status = res
                      ? (res.error ? `❌ ${res.error}` : `✅ ${res.done ?? ""}/${res.total ?? ""}`)
                      : (currentIdx === i ? "🔄 генерую…" : selected.has(i) ? "⏳ у черзі" : "—");
                    return (
                      <tr key={i} className={`border-t border-[#2A2723] ${currentIdx === i ? "bg-[#E8943A]/10" : ""}`}>
                        <td className="p-2"><input type="checkbox" checked={selected.has(i)} onChange={() => toggleRow(i)} disabled={phase === "running"} className="accent-[#E8943A]" /></td>
                        <td className="p-2 text-[#F5F0EB] whitespace-nowrap">{cell(r, cols.sku) || `row${i + 1}`}</td>
                        <td className="p-2 text-[#8B857F]">{cell(r, cols.product)}</td>
                        <td className="p-2 text-[#8B857F] whitespace-nowrap">{mapGender(cell(r, cols.gender))}</td>
                        <td className="p-2 text-[#8B857F] whitespace-nowrap">{cols.season ? cell(r, cols.season) : "—"}</td>
                        <td className="p-2 text-center text-[#8B857F]">{cols.photos.map((p) => cell(r, p)).filter(Boolean).length}</td>
                        <td className={`p-2 whitespace-nowrap ${res?.error ? "text-red-400" : currentIdx === i ? "text-[#E8943A]" : "text-[#8B857F]"}`}>
                          {firstUrl && <a href={firstUrl} target="_blank" rel="noreferrer" className="text-[#E8943A] underline mr-2">переглянути</a>}
                          {status}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="p-2 text-xs text-[#6B6560] border-t border-[#2A2723] flex justify-between">
              <span>Обрано <span className="text-[#E8943A]">{validRows.filter(({ i }) => selected.has(i)).length}</span> з {validRows.length}</span>
              {rows.length > validRows.length && <span>{rows.length - validRows.length} пропущено (немає фото/товару)</span>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">Категорія (для всіх)</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value as CategoryId)} disabled={phase === "running"}
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-3 py-2 text-sm text-[#F5F0EB]">
                {CATEGORY_LIST.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">Що генерувати</label>
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={phase === "running"}
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-3 py-2 text-sm text-[#F5F0EB]">
                <option value="images">Тільки фото</option>
                <option value="both">Фото + AI-описи</option>
                <option value="descriptions">Тільки AI-описи</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">Фон</label>
              <select value={bg} onChange={(e) => setBg(e.target.value as BgChoice)} disabled={phase === "running" || mode === "descriptions"}
                className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-3 py-2 text-sm text-[#F5F0EB]">
                <option value="studio">🏷️ Студія (всі)</option>
                <option value="any">🌆 Сцена — будь-яка</option>
                <option value="column">🌆 Сцена — за стовпцем «Сезонність»</option>
              </select>
            </div>
          </div>

          {mode !== "descriptions" && (
            <label className="flex items-center gap-2 text-sm text-[#8B857F] cursor-pointer">
              <input type="checkbox" checked={drive} onChange={(e) => setDrive(e.target.checked)} disabled={phase === "running"} className="accent-[#E8943A]" />
              ☁️ Вивантажити згенеровані фото на мій Google Drive (постійні посилання). Потребує підключеного Google у Налаштуваннях.
            </label>
          )}
          {validRows.length > 300 && phase === "idle" && (
            <p className="text-xs text-amber-400/90">⚠️ {validRows.length} товарів — це багато для одного заходу (повільно, тримай вкладку відкритою). Краще ділити на партії до ~300.</p>
          )}
          {phase !== "running" ? (
            <button onClick={runBatch} disabled={!detected || validRows.filter(({ i }) => selected.has(i)).length === 0}
              className="w-full bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-40 disabled:cursor-not-allowed text-[#0C0B0A] font-semibold py-3 rounded-xl transition-colors">
              {(() => { const n = validRows.filter(({ i }) => selected.has(i)).length; return phase === "done" ? "Запустити обрані знову" : `Запустити обрані — ${n} (~${Math.ceil(n * 45 / 60)} хв)`; })()}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-4">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-[#F5F0EB]">Обробляю: <span className="text-[#E8943A]">{progress.current}</span></span>
                  <span className="text-[#6B6560]">{progress.done}/{progress.total} · ✓{progress.ok} ✗{progress.fail}</span>
                </div>
                <div className="w-full bg-[#2A2723] rounded-full h-1.5">
                  <div className="bg-[#E8943A] h-1.5 rounded-full transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                </div>
              </div>
              <button onClick={() => { abortRef.current = true; }} className="text-xs text-[#6B6560] hover:text-red-400">Зупинити після поточного</button>
            </div>
          )}

          {phase === "done" && (
            <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-4 space-y-3">
              <p className="text-[#F5F0EB] font-medium">✓ Готово: {progress.ok} успішно, {progress.fail} з помилкою</p>
              <button onClick={exportResults} className="bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] text-sm font-medium px-4 py-2 rounded-lg">
                ⬇ Експорт Excel (посилання на згенеровані фото + описи)
              </button>
              <p className="text-[10px] text-[#6B6560]">Усі згенеровані набори також доступні в розділі «Історія». ⚠️ Посилання на фото в Excel дійсні ~7 днів — завантаж файли скоро (Drive-вивантаження зробимо за потреби).</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
