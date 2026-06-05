"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { CATEGORY_LIST, category, type CategoryId } from "@/lib/categories";

type Mode = "images" | "both" | "descriptions";
type BgChoice = "studio" | "any" | "column";

interface Row { [k: string]: unknown }
interface ColMap {
  sku?: string; product?: string; gender?: string; season?: string;
  color?: string; brand?: string; composition?: string; country?: string;
  size?: string; photos: string[];
}
interface Listing { title: string; description: string; bullets: string[]; tags: string[] }
interface ItemResult {
  sku?: string; status?: string; done?: number; total?: number;
  urls?: string[]; driveUrls?: string[]; photoUrls?: string[]; listing?: Listing; error?: string;
}

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
  const [headers, setHeaders] = useState<string[]>([]);
  const [cols, setCols] = useState<ColMap>({ photos: [] });
  const [fileName, setFileName] = useState("");

  const [categoryId, setCategoryId] = useState<CategoryId>("clothing");
  const cat = category(categoryId);
  const [presetId, setPresetId] = useState<string>("quick3");
  const [customAngles, setCustomAngles] = useState<string[]>(category("clothing").presets[0].angles.slice());
  const [mode, setMode] = useState<Mode>("images");
  const [bg, setBg] = useState<BgChoice>("studio");
  const [drive, setDrive] = useState(true);
  const [driveFolder, setDriveFolder] = useState("PhotoForge");

  const isCustomAngles = presetId === "custom";
  const selectedAngles = isCustomAngles
    ? customAngles
    : (cat.presets.find((p) => p.id === presetId)?.angles.slice() ?? cat.presets[0].angles.slice());

  function onCategory(id: CategoryId) {
    setCategoryId(id);
    setPresetId("quick3");
    setCustomAngles(category(id).presets[0].angles.slice());
  }
  function toggleAngle(id: string) {
    setPresetId("custom");
    setCustomAngles((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [resultsBySku, setResultsBySku] = useState<Record<string, ItemResult>>({});
  const [batchTotal, setBatchTotal] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchId, setBatchId] = useState<string | null>(null);
  const pollRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const skuOf = (r: Row, i: number) => cell(r, cols.sku) || `row${i + 1}`;

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
    setHeaders(hdrs);
    setCols(dcols);
    setPhase("idle");
    setResultsBySku({});
    pollRef.current = false;
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

  async function poll(id: string) {
    if (!pollRef.current) return;
    try {
      const res = await fetch(`/api/batch/${id}/status`);
      const data = await res.json().catch(() => ({ items: [] }));
      const map: Record<string, ItemResult> = {};
      for (const it of (data.items ?? [])) map[it.sku] = it;
      setResultsBySku(map);
      const items: ItemResult[] = data.items ?? [];
      if (items.length > 0 && items.every((it) => it.status === "done" || it.status === "error")) {
        setPhase("done");
        pollRef.current = false;
        return;
      }
    } catch { /* keep polling */ }
    if (pollRef.current) setTimeout(() => poll(id), 3000);
  }

  async function startBatch() {
    const toRun = validRows.filter(({ i }) => selected.has(i));
    if (toRun.length === 0) return;
    const products = toRun.map(({ r, i }) => ({
      sku: skuOf(r, i),
      productType: cell(r, cols.product),
      name: cell(r, cols.product),
      brand: cell(r, cols.brand),
      color: cell(r, cols.color),
      size: cell(r, cols.size),
      gender: mapGender(cell(r, cols.gender)),
      season: rowSeason(r),
      composition: cell(r, cols.composition),
      country: cell(r, cols.country),
      photoUrls: cols.photos.map((p) => cell(r, p)).filter(Boolean),
    }));
    setPhase("running");
    setResultsBySku({});
    setBatchTotal(products.length);
    try {
      const res = await fetch("/api/batch/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products, category: categoryId, quality: "standard", mode,
          angleIds: selectedAngles, drive, driveFolderName: drive ? driveFolder.trim() : "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.batchId) { setPhase("idle"); alert(data.error || "Не вдалося запустити"); return; }
      setBatchId(data.batchId);
      pollRef.current = true;
      poll(data.batchId);
    } catch {
      setPhase("idle");
    }
  }

  async function exportResults() {
    const XLSX = await import("xlsx");
    const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const validIdx = new Set(validRows.map(({ i }) => i));
    const all = Object.values(resultsBySku);
    const maxImgs = Math.max(1, ...all.map((r) => Math.max(r.urls?.filter(Boolean).length ?? 0, r.driveUrls?.filter(Boolean).length ?? 0)));
    const out = rows.map((r, i) => {
      const res = resultsBySku[skuOf(r, i)];
      const row: Row = { ...r };
      if (res) {
        for (let k = 0; k < maxImgs; k++) {
          row[`Згенерована картинка ${k + 1}`] = res.driveUrls?.[k] || res.urls?.[k] || "";
        }
        row["Статус Генерації"] = res.error
          ? `Помилка: ${res.error}`
          : (res.status === "done" ? `Оброблено (${res.done}/${res.total})` : res.status ?? "");
        if (res.listing) {
          row["AI_Title"] = safe(res.listing.title);
          row["AI_Опис"] = safe(res.listing.description);
          row["AI_Переваги"] = safe(res.listing.bullets.join("\n"));
          row["AI_Теги"] = safe(res.listing.tags.join(", "));
        }
      } else {
        row["Статус Генерації"] = validIdx.has(i) ? "Не обрано" : "Пропущено (немає фото/типу товару)";
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.writeFile(wb, `${fileName.replace(/\.[^.]+$/, "") || "photoforge"}_generated.xlsx`);
  }

  const detected = cols.photos.length > 0 && (!!cols.product || mode === "descriptions");
  const resList = Object.values(resultsBySku);
  const okCount = resList.filter((r) => r.status === "done").length;
  const failCount = resList.filter((r) => r.status === "error").length;
  const finished = okCount + failCount;

  function statusOf(res: ItemResult | undefined): string {
    if (!res) return phase === "running" ? "⏳ у черзі" : "—";
    if (res.status === "done") return `✅ ${res.done}/${res.total}`;
    if (res.status === "error") return `❌ ${res.error || "помилка"}`;
    if (res.status === "processing") return `🔄 ${res.done}/${res.total}`;
    return "⏳ у черзі";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">
          Масова генерація <span className="text-[10px] align-middle bg-[#E8943A]/20 text-[#E8943A] px-2 py-0.5 rounded">BETA</span>
        </h1>
        <p className="text-[#6B6560] mt-1">Завантаж Excel, обери товари — генерація йде у фоні (можна закрити вкладку).</p>
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
          {/* Column mapping */}
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-4 space-y-3">
            <p className="text-[#F5F0EB] text-sm font-medium">Зіставлення колонок <span className="text-[#6B6560] font-normal text-xs">— виправ вручну, якщо щось визначилось не так</span></p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              {([["sku", "Артикул"], ["product", "Товар / Вид"], ["gender", "Стать (Gender)"], ["season", "Сезонність"], ["color", "Колір"], ["brand", "Бренд"]] as ["sku" | "product" | "gender" | "season" | "color" | "brand", string][]).map(([key, label]) => (
                <div key={key}>
                  <label className="block text-[#6B6560] mb-1">{label}</label>
                  <select value={cols[key] ?? ""} onChange={(e) => setCols((c) => ({ ...c, [key]: e.target.value || undefined }))} disabled={phase === "running"}
                    className="w-full bg-[#0C0B0A] border border-[#2A2723] rounded px-2 py-1.5 text-[#F5F0EB] focus:border-[#E8943A] focus:outline-none">
                    <option value="">— не використовувати</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div>
              <p className="text-[#6B6560] text-xs mb-1">🖼 Колонки з фото ({cols.photos.length}) — клікни, щоб увімкнути/вимкнути:</p>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-auto">
                {headers.map((h) => {
                  const on = cols.photos.includes(h);
                  return (
                    <button key={h} type="button" disabled={phase === "running"}
                      onClick={() => setCols((c) => ({ ...c, photos: on ? c.photos.filter((p) => p !== h) : [...c.photos, h] }))}
                      className={`text-[10px] px-2 py-1 rounded border transition-colors ${on ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]" : "bg-[#0C0B0A] border-[#2A2723] text-[#6B6560] hover:text-[#F5F0EB]"}`}>
                      {h}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-xs text-[#6B6560]">
              Рядків: {rows.length} · придатних: <span className="text-[#F5F0EB]">{validRows.length}</span>
              {!detected && <span className="text-red-400"> · ⚠️ обери колонку «Товар» і хоча б одну фото-колонку</span>}
            </p>
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
                    const res = resultsBySku[skuOf(r, i)];
                    const urls = res?.urls?.filter(Boolean) ?? [];
                    const active = res?.status === "processing";
                    return (
                      <tr key={i} className={`border-t border-[#2A2723] ${active ? "bg-[#E8943A]/10" : ""}`}>
                        <td className="p-2"><input type="checkbox" checked={selected.has(i)} onChange={() => toggleRow(i)} disabled={phase === "running"} className="accent-[#E8943A]" /></td>
                        <td className="p-2 text-[#F5F0EB] whitespace-nowrap">{skuOf(r, i)}</td>
                        <td className="p-2 text-[#8B857F]">{cell(r, cols.product)}</td>
                        <td className="p-2 text-[#8B857F] whitespace-nowrap">{mapGender(cell(r, cols.gender))}</td>
                        <td className="p-2 text-[#8B857F] whitespace-nowrap">{cols.season ? cell(r, cols.season) : "—"}</td>
                        <td className="p-2 text-center text-[#8B857F]">{cols.photos.map((p) => cell(r, p)).filter(Boolean).length}</td>
                        <td className={`p-2 whitespace-nowrap ${res?.error ? "text-red-400" : active ? "text-[#E8943A]" : "text-[#8B857F]"}`}>
                          {urls.length > 0 && (
                            <span className="mr-2">
                              {res!.urls!.map((u, k) => (u ? <a key={k} href={u} target="_blank" rel="noreferrer" className="text-[#E8943A] underline mr-1" title={`фото ${k + 1}`}>{k + 1}</a> : null))}
                            </span>
                          )}
                          {statusOf(res)}
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

          {/* Options */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">Категорія (для всіх)</label>
              <select value={categoryId} onChange={(e) => onCategory(e.target.value as CategoryId)} disabled={phase === "running"}
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

          {/* Angles */}
          {mode !== "descriptions" && (
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">Ракурси <span className="text-[#F5F0EB]">({selectedAngles.length})</span></label>
              <div className="flex flex-wrap gap-2">
                {cat.presets.map((p) => (
                  <button type="button" key={p.id} onClick={() => setPresetId(p.id)} disabled={phase === "running"}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${presetId === p.id ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]" : "bg-[#161412] border-[#2A2723] text-[#6B6560] hover:text-[#F5F0EB]"}`}>
                    {p.label}
                  </button>
                ))}
                <button type="button" onClick={() => setPresetId("custom")} disabled={phase === "running"}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${isCustomAngles ? "bg-[#E8943A]/15 border-[#E8943A] text-[#E8943A]" : "bg-[#161412] border-[#2A2723] text-[#6B6560] hover:text-[#F5F0EB]"}`}>
                  Обрати вручну…
                </button>
              </div>
              {isCustomAngles && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 bg-[#161412] border border-[#2A2723] rounded-lg p-3 mt-2">
                  {cat.angles.map((a) => {
                    const on = customAngles.includes(a.id);
                    return (
                      <label key={a.id} className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${on ? "bg-[#E8943A]/10" : "hover:bg-[#1E1C19]"}`} title={a.desc}>
                        <input type="checkbox" checked={on} onChange={() => toggleAngle(a.id)} disabled={phase === "running"} className="mt-1 accent-[#E8943A]" />
                        <span className={`text-xs ${on ? "text-[#F5F0EB]" : "text-[#6B6560]"}`}>{a.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Drive */}
          {mode !== "descriptions" && (
            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${drive ? "bg-[#E8943A]/10 border-[#E8943A]/50" : "bg-[#161412] border-[#2A2723]"}`}>
              <input type="checkbox" checked={drive} onChange={(e) => setDrive(e.target.checked)} disabled={phase === "running"} className="mt-0.5 w-4 h-4 accent-[#E8943A]" />
              <span className="text-sm">
                <span className="text-[#F5F0EB] font-medium">☁️ Вивантажити фото на Google Drive</span>
                <span className="block text-xs text-[#6B6560] mt-0.5">Постійні посилання + папки за артикулом (як у Make). Потребує підключеного Google у Налаштуваннях.</span>
              </span>
            </label>
          )}
          {mode !== "descriptions" && drive && (
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">📁 Папка на Google Drive</label>
              <input type="text" value={driveFolder} onChange={(e) => setDriveFolder(e.target.value)} disabled={phase === "running"}
                placeholder="PhotoForge" className="w-full sm:w-80 bg-[#0C0B0A] border border-[#2A2723] rounded px-3 py-2 text-sm text-[#F5F0EB] focus:border-[#E8943A] focus:outline-none" />
              <p className="text-[10px] text-[#6B6560] mt-1">Усі товари ляжуть у цю папку, кожен — у підпапку зі своїм артикулом.</p>
            </div>
          )}

          {phase !== "running" ? (
            <button onClick={startBatch} disabled={!detected || validRows.filter(({ i }) => selected.has(i)).length === 0}
              className="w-full bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-40 disabled:cursor-not-allowed text-[#0C0B0A] font-semibold py-3 rounded-xl transition-colors">
              {(() => { const n = validRows.filter(({ i }) => selected.has(i)).length; return phase === "done" ? "Запустити обрані знову" : `Запустити обрані — ${n}`; })()}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-4">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-[#F5F0EB]">Генерую у фоні…</span>
                  <span className="text-[#6B6560]">{finished}/{batchTotal} · ✓{okCount} ✗{failCount}</span>
                </div>
                <div className="w-full bg-[#2A2723] rounded-full h-1.5">
                  <div className="bg-[#E8943A] h-1.5 rounded-full transition-all" style={{ width: `${batchTotal ? (finished / batchTotal) * 100 : 0}%` }} />
                </div>
                <p className="text-[10px] text-[#6B6560] mt-2">✅ Можна закрити вкладку — генерація триває на сервері. Результати з'являться тут і в «Історії».</p>
              </div>
              <button onClick={() => { pollRef.current = false; setPhase("done"); }} className="text-xs text-[#6B6560] hover:text-[#F5F0EB]">Сховати прогрес (генерація продовжиться у фоні)</button>
            </div>
          )}

          {phase === "done" && (
            <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-4 space-y-3">
              <p className="text-[#F5F0EB] font-medium">✓ {okCount} готово, {failCount} з помилкою</p>
              <div className="flex flex-wrap gap-2">
                <button onClick={exportResults} className="bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] text-sm font-medium px-4 py-2 rounded-lg">
                  ⬇ Експорт Excel (посилання на фото + описи)
                </button>
                {batchId && (
                  <Link href={`/dashboard/history/${batchId}`} className="bg-[#2A2723] hover:bg-[#373330] text-[#F5F0EB] text-sm font-medium px-4 py-2 rounded-lg">
                    🔍 Перевірити фото (звірити з оригіналами)
                  </Link>
                )}
              </div>
              <p className="text-[10px] text-[#6B6560]">Експорт бере постійні Drive-посилання, якщо Drive увімкнено (інакше — посилання сховища на ~7 днів). Усе також у «Історії».</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
