"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CATEGORY_LIST, category, classifyCategory, type CategoryId } from "@/lib/categories";
import { saveUpload, listUploads, getUpload, deleteUpload, type BulkUpload, type BulkUploadMeta } from "@/lib/bulk-store";
import FolderPicker from "./folder-picker";

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

// Normalize an article code for matching across uploads. Excel/xlsx often reads a
// numeric code differently between files ("00123" → 123, "123" → "123.0"), so an
// exact string match misses already-generated articles. We trim, lowercase, drop
// the trailing ".0" float artifact, and strip leading zeros ONLY on purely-numeric
// codes (alphanumeric codes like "A012" keep theirs, so distinct SKUs never merge).
const normSku = (s: string) => {
  let x = (s ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/\.0+$/, "");
  if (/^\d+$/.test(x)) x = x.replace(/^0+/, "") || "0";
  return x;
};

export default function BatchPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [cols, setCols] = useState<ColMap>({ photos: [] });
  const [fileName, setFileName] = useState("");

  const [categoryId, setCategoryId] = useState<CategoryId>("clothing");
  const cat = category(categoryId);
  const [presetId, setPresetId] = useState<string>("full");
  const [customAngles, setCustomAngles] = useState<string[]>(category("clothing").presets[0].angles.slice());
  const [mode, setMode] = useState<Mode>("images");
  const [bg, setBg] = useState<BgChoice>("studio");
  const [drive, setDrive] = useState(true);
  const [driveFolder, setDriveFolder] = useState("PhotoForge");
  const [drivePickedId, setDrivePickedId] = useState<string | null>(null);
  const [drivePickedLabel, setDrivePickedLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const isCustomAngles = presetId === "custom";
  const selectedAngles = isCustomAngles
    ? customAngles
    : (cat.presets.find((p) => p.id === presetId)?.angles.slice() ?? cat.presets[0].angles.slice());

  function onCategory(id: CategoryId) {
    setCategoryId(id);
    setPresetId("full");
    setCustomAngles(category(id).presets[0].angles.slice());
  }

  // Each product is routed to its OWN category (auto-detected from the «Товар»
  // text), falling back to the dropdown for unrecognized items — so a mixed file
  // (vases + shirts) doesn't put non-wearable goods on a model.
  // Priority: manual per-row override → keyword → AI → dropdown fallback.
  const resolveCat = (r: Row, i: number): CategoryId => {
    const name = cell(r, cols.product);
    return catOverride[i] ?? classifyCategory(name) ?? aiCat[name] ?? categoryId;
  };
  // Was this row auto-resolved (keyword or AI), or just the dropdown fallback?
  const catIsKnown = (r: Row, i: number) => i in catOverride || !!classifyCategory(cell(r, cols.product)) || !!aiCat[cell(r, cols.product)];
  // The chosen preset, mapped to the resolved category's own angle set.
  const anglesForCat = (catId: CategoryId): string[] => {
    const c = category(catId);
    if (presetId === "custom") {
      return catId === categoryId ? customAngles.slice() : (c.presets.find((p) => p.id === "quick3")?.angles ?? c.presets[0].angles).slice();
    }
    return (c.presets.find((p) => p.id === presetId)?.angles ?? c.presets[0].angles).slice();
  };
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

  // #6: server status per SKU (across all past runs) + "hide done" filter +
  // remember the uploaded sheet across reloads.
  type SkuStat = { status: string; done: number; total: number; approved: boolean; batchId: string | null; at: string };
  const [skuStatus, setSkuStatus] = useState<Record<string, SkuStat>>({});
  // Normalized index so a formatting difference in the article code (leading zeros,
  // ".0", case) doesn't hide an already-generated SKU.
  const statByNorm = useMemo(() => {
    const m: Record<string, SkuStat> = {};
    for (const [k, v] of Object.entries(skuStatus)) m[normSku(k)] = v;
    return m;
  }, [skuStatus]);
  const skuStat = useCallback(
    (sku: string): SkuStat | undefined => skuStatus[sku] ?? statByNorm[normSku(sku)],
    [skuStatus, statByNorm]
  );
  const [hideDone, setHideDone] = useState(false);
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(50);
  // Category resolution: AI fills keyword gaps; per-row manual override wins.
  const [aiCat, setAiCat] = useState<Record<string, CategoryId>>({});
  const [catOverride, setCatOverride] = useState<Record<number, CategoryId>>({});
  const [classifying, setClassifying] = useState(false);

  // Ask the AI to categorize product names that keyword-matching couldn't place.
  const classifyMissing = useCallback(async (rws: Row[], c: ColMap) => {
    const names = Array.from(new Set(
      rws.map((r) => cell(r, c.product)).filter(Boolean).filter((n) => !classifyCategory(n))
    ));
    if (names.length === 0) return;
    setClassifying(true);
    try {
      const res = await fetch("/api/bulk/classify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const d = await res.json();
      if (d?.byName) setAiCat((prev) => ({ ...prev, ...d.byName }));
    } catch { /* keyword/dropdown fallback */ } finally { setClassifying(false); }
  }, []);

  const skuOf = (r: Row, i: number) => cell(r, cols.sku) || `row${i + 1}`;

  const loadSkuStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/bulk/status");
      const d = await r.json();
      if (d?.bySku) setSkuStatus(d.bySku);
    } catch { /* ignore */ }
  }, []);

  // Uploads live in IndexedDB (big files OK — localStorage's ~5MB cap was dropping
  // large new files, so an old upload kept loading). A switcher lets you pick a list.
  const [uploads, setUploads] = useState<BulkUploadMeta[]>([]);
  const [currentUploadId, setCurrentUploadId] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyUpload = useCallback((u: BulkUpload, runAi: boolean) => {
    const c: ColMap = { photos: [], ...((u.cols as object) ?? {}) };
    setRows(u.rows as Row[]); setHeaders(u.headers ?? []); setCols(c); setFileName(u.fileName ?? "");
    setAiCat((u.aiCat as Record<string, CategoryId>) ?? {});
    setCatOverride((u.catOverride as Record<number, CategoryId>) ?? {});
    setResultsBySku({}); setPhase("idle"); pollRef.current = false;
    const valid = (u.rows as Row[]).map((r, i) => ({ r, i }))
      .filter(({ r }) => (c.photos ?? []).some((p) => cell(r, p)) && cell(r, c.product)).map(({ i }) => i);
    setSelected(new Set(valid));
    setCurrentUploadId(u.id);
    try { localStorage.setItem("pf_bulk_current", u.id); } catch { /* ignore */ }
    if (runAi && (!u.aiCat || Object.keys(u.aiCat).length === 0)) classifyMissing(u.rows as Row[], c);
  }, [classifyMissing]);

  async function loadUploadById(id: string) {
    const u = await getUpload(id);
    if (u) applyUpload(u, true);
  }

  // Mount: load the list of uploads + restore the last-used (or newest) one.
  useEffect(() => {
    (async () => {
      try {
        const metas = await listUploads();
        setUploads(metas);
        if (metas.length) {
          let pick = "";
          try { pick = localStorage.getItem("pf_bulk_current") ?? ""; } catch { /* ignore */ }
          const id = metas.find((m) => m.id === pick)?.id ?? metas[0].id;
          const u = await getUpload(id);
          if (u) applyUpload(u, true);
        }
      } catch { /* ignore */ }
    })();
    loadSkuStatus();
  }, [loadSkuStatus, applyUpload]);

  // Persist the current upload (debounced) whenever its data changes.
  useEffect(() => {
    if (rows.length === 0 || !currentUploadId) return;
    const id = currentUploadId; // capture at schedule time → never save under a switched id
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveUpload({ id, fileName, savedAt: Date.now(), rows, headers, cols, aiCat, catOverride })
        .then(() => listUploads().then(setUploads))
        .catch(() => { /* ignore */ });
    }, 800);
  }, [rows, headers, cols, fileName, aiCat, catOverride, currentUploadId]);

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
    setAiCat({});
    setCatOverride({});
    // Save this upload as a NEW entry in IndexedDB + make it current.
    const id = (crypto?.randomUUID?.() ?? String(Date.now()));
    setCurrentUploadId(id);
    try { localStorage.setItem("pf_bulk_current", id); } catch { /* ignore */ }
    saveUpload({ id, fileName: f.name, savedAt: Date.now(), rows: json, headers: hdrs, cols: dcols, aiCat: {}, catOverride: {} })
      .then(() => listUploads().then(setUploads)).catch(() => { /* ignore */ });
    loadSkuStatus();           // refresh which of these SKUs are already done/approved
    classifyMissing(json, dcols); // AI-categorize names the keywords can't place
  }

  const validRows = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => cols.photos.some((p) => cell(r, p)) && (cell(r, cols.product) || mode === "descriptions"));

  // A SKU is "done" if its latest generation was approved or finished.
  const isDoneSku = (sku: string) => { const s = skuStat(sku); return !!s && (s.approved || s.status === "done"); };
  const doneCount = validRows.filter(({ r, i }) => isDoneSku(skuOf(r, i))).length;
  // Rows shown in the table (optionally hiding already-done ones).
  const displayRows = hideDone ? validRows.filter(({ r, i }) => !isDoneSku(skuOf(r, i))) : validRows;

  // Pagination — the list can be thousands of rows; show one page at a time.
  const pageCount = Math.max(1, Math.ceil(displayRows.length / perPage));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = displayRows.slice(safePage * perPage, safePage * perPage + perPage);

  const allSelected = pageRows.length > 0 && pageRows.every(({ i }) => selected.has(i));
  function toggleRow(i: number) {
    setSelected((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  }
  function toggleAll() { // selects/clears the CURRENT page
    setSelected((s) => {
      const n = new Set(s);
      if (allSelected) pageRows.forEach(({ i }) => n.delete(i));
      else pageRows.forEach(({ i }) => n.add(i));
      return n;
    });
  }
  function selectNotDone() {
    setSelected(new Set(validRows.filter(({ r, i }) => !isDoneSku(skuOf(r, i))).map(({ i }) => i)));
  }
  // Pick the first N of the currently-shown (filtered) list — no clicking 500 boxes.
  function selectFirst(n: number) {
    setSelected(new Set(displayRows.slice(0, Math.min(n, displayRows.length)).map(({ i }) => i)));
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
        loadSkuStatus(); // refresh the done/approved overlay
        return;
      }
    } catch { /* keep polling */ }
    if (pollRef.current) setTimeout(() => poll(id), 3000);
  }

  async function cancelBatch() {
    if (!batchId || !confirm("Скасувати цю генерацію? Незавершені товари зупиняться.")) return;
    pollRef.current = false;
    try { await fetch(`/api/batch/${batchId}/cancel`, { method: "POST" }); } catch { /* ignore */ }
    setPhase("done");
    loadSkuStatus();
  }

  async function startBatch(cards = false, draft = false) {
    const toRun = validRows.filter(({ i }) => selected.has(i));
    if (toRun.length === 0) return;
    const products = toRun.map(({ r, i }) => {
      const pcat = resolveCat(r, i);
      return {
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
        category: pcat,                 // per-product category (auto-detected)
        angleIds: anglesForCat(pcat),   // angles for THAT category
      };
    });
    setPhase("running");
    setResultsBySku({});
    setBatchTotal(products.length);
    try {
      const res = await fetch("/api/batch/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products, category: categoryId, quality: "standard", mode,
          angleIds: selectedAngles, drive, draft,
          driveParentId: drive ? (drivePickedId ?? undefined) : undefined,
          driveFolderName: drive && !drivePickedId ? driveFolder.trim() : "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.batchId) { setPhase("idle"); alert(data.error || "Не вдалося запустити"); return; }
      setBatchId(data.batchId);
      // Card / stepwise mode: go straight to the per-article view (live fill for
      // cards; draft = generate each product on demand there).
      if (cards || draft) { router.push(`/dashboard/history/${data.batchId}`); return; }
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
      // Sanitize ALL string cells (not just AI fields) against spreadsheet
      // formula-injection when the file is reopened in Excel/Sheets.
      const row: Row = Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? safe(v) : v])
      );
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

  // Server-side status for a SKU from past runs (shown when there's no live result).
  function serverBadge(sku: string) {
    const s = skuStat(sku);
    if (!s) return <span className="text-[#6B6560]">⬜ нове</span>;
    if (s.approved) return <span className="text-green-400">✅ підтверджено</span>;
    if (s.status === "done")
      return s.batchId
        ? <Link href={`/dashboard/history/${s.batchId}`} className="text-[#E8943A] underline">✓ {s.done}/{s.total} — перевірити</Link>
        : <span className="text-[#E8943A]">✓ {s.done}/{s.total}</span>;
    if (s.status === "error") return <span className="text-red-400">✗ помилка</span>;
    if (s.status === "queued" || s.status === "processing") return <span className="text-[#E8943A]">🔄 у роботі</span>;
    return <span className="text-[#6B6560]">⬜ нове</span>;
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

      {/* Saved-lists switcher (IndexedDB) */}
      {uploads.length > 0 && phase !== "running" && (
        <div className="flex items-center gap-2 -mt-2 text-xs flex-wrap">
          <span className="text-[#6B6560]">📂 Мої списки:</span>
          <select
            value={currentUploadId ?? ""}
            onChange={(e) => loadUploadById(e.target.value)}
            className="bg-[#161412] border border-[#2A2723] text-[#F5F0EB] rounded px-2 py-1 max-w-[60vw]"
          >
            {uploads.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fileName} · {u.count} тов. · {new Date(u.savedAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </option>
            ))}
          </select>
          {currentUploadId && (
            <button type="button" onClick={async () => {
              if (!confirm("Видалити цей список із памʼяті? (Згенеровані фото лишаться в Історії)")) return;
              const id = currentUploadId;
              await deleteUpload(id);
              try { localStorage.removeItem("pf_bulk_current"); } catch { /* ignore */ }
              const metas = await listUploads(); setUploads(metas);
              if (metas.length) { await loadUploadById(metas[0].id); }
              else { setCurrentUploadId(null); setRows([]); setHeaders([]); setCols({ photos: [] }); setFileName(""); setSelected(new Set()); setResultsBySku({}); setAiCat({}); setCatOverride({}); }
            }} className="text-[#6B6560] hover:text-red-400 underline">🗑 Видалити список</button>
          )}
        </div>
      )}

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

          {/* Quick-select toolbar — grab the first N without clicking each box */}
          {phase !== "running" && (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="text-[#6B6560]">Обрати перші:</span>
              {[10, 20, 50, 100, 200, 500].map((n) => (
                <button key={n} type="button" onClick={() => selectFirst(n)} disabled={displayRows.length === 0}
                  className="px-2.5 py-1 rounded border border-[#2A2723] bg-[#161412] text-[#F5F0EB] hover:border-[#E8943A] disabled:opacity-40">
                  {n}
                </button>
              ))}
              <button type="button" onClick={() => setSelected(new Set())} className="px-2.5 py-1 rounded text-[#6B6560] hover:text-red-400">Очистити</button>
              <span className="text-[#6B6560] ml-1">(макс 500 за раз)</span>
            </div>
          )}

          {/* Selectable products table with live status */}
          <div className="bg-[#161412] border border-[#2A2723] rounded-xl overflow-hidden">
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#1E1C19] text-[#6B6560] z-10">
                  <tr>
                    <th className="p-2 w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={phase === "running"} className="accent-[#E8943A]" /></th>
                    <th className="p-2 text-left font-medium">Артикул</th>
                    <th className="p-2 text-left font-medium">Товар</th>
                    <th className="p-2 text-left font-medium">Категорія</th>
                    <th className="p-2 text-left font-medium">Стать</th>
                    <th className="p-2 text-left font-medium">Сезон</th>
                    <th className="p-2 text-center font-medium">Фото</th>
                    <th className="p-2 text-left font-medium">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map(({ r, i }) => {
                    const res = resultsBySku[skuOf(r, i)];
                    const urls = res?.urls?.filter(Boolean) ?? [];
                    const active = res?.status === "processing";
                    return (
                      <tr key={i} className={`border-t border-[#2A2723] ${active ? "bg-[#E8943A]/10" : ""}`}>
                        <td className="p-2"><input type="checkbox" checked={selected.has(i)} onChange={() => toggleRow(i)} disabled={phase === "running"} className="accent-[#E8943A]" /></td>
                        <td className="p-2 text-[#F5F0EB] whitespace-nowrap">{skuOf(r, i)}</td>
                        <td className="p-2 text-[#8B857F]">{cell(r, cols.product)}</td>
                        <td className="p-2 whitespace-nowrap">
                          <select value={resolveCat(r, i)} disabled={phase === "running"}
                            onChange={(e) => setCatOverride((o) => ({ ...o, [i]: e.target.value as CategoryId }))}
                            title={catIsKnown(r, i) ? "Категорія визначена авто — можеш виправити" : "Не розпізнано — обери вручну"}
                            className={`bg-[#0C0B0A] border rounded px-1.5 py-1 text-[11px] ${catIsKnown(r, i) ? "border-[#2A2723] text-[#8B857F]" : "border-[#E8943A]/60 text-[#E8943A]"}`}>
                            {CATEGORY_LIST.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
                          </select>
                        </td>
                        <td className="p-2 text-[#8B857F] whitespace-nowrap">{mapGender(cell(r, cols.gender))}</td>
                        <td className="p-2 text-[#8B857F] whitespace-nowrap">{cols.season ? cell(r, cols.season) : "—"}</td>
                        <td className="p-2 text-center text-[#8B857F]">{cols.photos.map((p) => cell(r, p)).filter(Boolean).length}</td>
                        <td className={`p-2 whitespace-nowrap ${res?.error ? "text-red-400" : active ? "text-[#E8943A]" : "text-[#8B857F]"}`}>
                          {urls.length > 0 && (
                            <span className="mr-2">
                              {res!.urls!.map((u, k) => (u ? <a key={k} href={u} target="_blank" rel="noreferrer" className="text-[#E8943A] underline mr-1" title={`фото ${k + 1}`}>{k + 1}</a> : null))}
                            </span>
                          )}
                          {res ? statusOf(res) : serverBadge(skuOf(r, i))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="p-2 text-xs text-[#6B6560] border-t border-[#2A2723] flex flex-wrap items-center gap-x-4 gap-y-1 justify-between">
              <span>Обрано <span className="text-[#E8943A]">{validRows.filter(({ i }) => selected.has(i)).length}</span> з {hideDone ? displayRows.length : validRows.length}</span>
              <div className="flex items-center gap-3 flex-wrap">
                {classifying && <span className="text-[#E8943A]">🤖 AI визначає категорії…</span>}
                {doneCount > 0 && <span className="text-green-400">✓ вже зроблено: {doneCount}</span>}
                <button type="button" onClick={selectNotDone} disabled={phase === "running"}
                  className="text-[#E8943A] hover:underline disabled:opacity-40">Обрати лише не зроблені</button>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} className="accent-[#E8943A]" />
                  Сховати вже зроблені
                </label>
                {rows.length > validRows.length && <span>{rows.length - validRows.length} пропущено</span>}
              </div>
            </div>
            {/* Pagination */}
            {displayRows.length > perPage && (
              <div className="p-2 text-xs text-[#6B6560] border-t border-[#2A2723] flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}
                    className="px-2 py-1 rounded bg-[#1E1C19] hover:bg-[#2A2723] disabled:opacity-40 text-[#F5F0EB]">← Назад</button>
                  <span>Стор. <span className="text-[#F5F0EB]">{safePage + 1}</span> / {pageCount}</span>
                  <button type="button" onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1}
                    className="px-2 py-1 rounded bg-[#1E1C19] hover:bg-[#2A2723] disabled:opacity-40 text-[#F5F0EB]">Далі →</button>
                </div>
                <label className="flex items-center gap-1.5">
                  На сторінці:
                  <select value={perPage} onChange={(e) => { setPerPage(Number(e.target.value)); setPage(0); }}
                    className="bg-[#161412] border border-[#2A2723] rounded px-2 py-1 text-[#F5F0EB]">
                    {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>

          {/* Options */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-[#6B6560] mb-1">Категорія <span className="font-normal">— запасна (тип визначається авто з назви; «*» = не розпізнано)</span></label>
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
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" onClick={() => setPickerOpen(true)} disabled={phase === "running"}
                  className="bg-[#161412] border border-[#2A2723] hover:border-[#E8943A] rounded px-3 py-2 text-sm text-[#F5F0EB]">
                  📂 Обрати папку з Диска…
                </button>
                <span className="text-sm text-[#8B857F]">
                  {drivePickedId ? <>Обрано: <span className="text-[#E8943A]">{drivePickedLabel}</span></> : <>або нова папка: <input type="text" value={driveFolder} onChange={(e) => setDriveFolder(e.target.value)} disabled={phase === "running"} placeholder="PhotoForge" className="bg-[#0C0B0A] border border-[#2A2723] rounded px-2 py-1 text-sm text-[#F5F0EB] w-44 focus:border-[#E8943A] focus:outline-none" /></>}
                </span>
                {drivePickedId && <button type="button" onClick={() => { setDrivePickedId(null); setDrivePickedLabel(""); }} className="text-xs text-[#6B6560] hover:text-red-400 underline">скинути</button>}
              </div>
              <p className="text-[10px] text-[#6B6560] mt-1">Усі товари ляжуть у цю папку, кожен — у підпапку зі своїм артикулом.</p>
            </div>
          )}
          {pickerOpen && (
            <FolderPicker
              onClose={() => setPickerOpen(false)}
              onPick={(id, label) => { setDrivePickedId(id); setDrivePickedLabel(label); setPickerOpen(false); }}
            />
          )}

          {phase !== "running" ? (
            <div className="space-y-2">
              {/* PRIMARY: fire everything into the background queue AND open the card
                  review, where photos fill in live as the worker grinds. The main
                  "select 50 → generate in background → review/approve as they fill" flow. */}
              <button onClick={() => startBatch(true)} disabled={!detected || validRows.filter(({ i }) => selected.has(i)).length === 0}
                className="w-full bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-40 disabled:cursor-not-allowed text-[#0C0B0A] font-semibold py-3 rounded-xl transition-colors">
                {(() => { const n = validRows.filter(({ i }) => selected.has(i)).length; return phase === "done" ? "⚡ Запустити у фоні знову" : `⚡ Запустити всі у фоні — ${n}`; })()}
                <span className="block text-[11px] font-normal opacity-80">генеруються самі · ти лиш гортаєш картки й апруваєш</span>
              </button>
              <button onClick={() => startBatch(false, true)} disabled={!detected || validRows.filter(({ i }) => selected.has(i)).length === 0}
                className="w-full bg-[#161412] border border-[#E8943A]/50 hover:border-[#E8943A] disabled:opacity-40 disabled:cursor-not-allowed text-[#E8943A] font-medium py-2.5 rounded-xl transition-colors text-sm">
                🃏 Поступово — кожен товар генерую вручну (тісний контроль при 429)
              </button>
              <button onClick={() => startBatch(false)} disabled={!detected || validRows.filter(({ i }) => selected.has(i)).length === 0}
                className="w-full bg-[#161412] border border-[#2A2723] hover:border-[#E8943A] disabled:opacity-40 disabled:cursor-not-allowed text-[#8B857F] hover:text-[#E8943A] text-xs font-medium py-2 rounded-xl transition-colors">
                Просто поставити в чергу (без переходу в картки)
              </button>
              <p className="text-[10px] text-[#6B6560] text-center">«Запустити у фоні» (рекомендую): усі обрані стають у чергу й генеруються самі; одразу відкриється перегляд карток — гортаєш, фото доливаються наживо, тиснеш «ОК і далі». «Поступово» — генеруєш кожен товар вручну своєю кнопкою (зручно, коли 429 сильно лютує).</p>
            </div>
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
              <div className="flex items-center gap-4">
                <button onClick={cancelBatch}
                  className="bg-red-500/15 hover:bg-red-500/25 text-red-400 text-sm font-medium px-4 py-2 rounded-lg">⛔ Скасувати генерацію</button>
                <button onClick={() => { pollRef.current = false; setPhase("done"); }} className="text-xs text-[#6B6560] hover:text-[#F5F0EB]">Сховати прогрес (триває у фоні)</button>
              </div>
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
