"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Slot { index: number; angle: string; url: string; driveUrl: string; rejected?: boolean }
interface Item {
  id: string; sku: string; productType: string; status: string;
  done: number; total: number; originals: string[]; slots: Slot[];
  season?: string; approved?: boolean; onModel?: boolean;
}

type SceneChoice = "studio" | "seasonal" | "free";
const SCENE_LABEL: Record<SceneChoice, string> = { studio: "Студія", seasonal: "За сезоном", free: "Довільна" };

export default function QAClient({ batchId }: { batchId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(new Set()); // keys in flight — parallel regen
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [sceneBySlot, setSceneBySlot] = useState<Record<string, SceneChoice>>({});
  const [noteBySlot, setNoteBySlot] = useState<Record<string, string>>({}); // per-angle correction note
  const approvedInit = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/qa/${batchId}`);
      const data = await res.json();
      if (Array.isArray(data.items)) {
        setItems(data.items);
        // Seed approvals from the server ONCE; later polls must not clobber the
        // user's in-session toggles.
        if (!approvedInit.current) {
          setApproved(Object.fromEntries(data.items.map((it: Item) => [it.id, !!it.approved])));
          approvedInit.current = true;
        }
      }
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => { load(); }, [load]);

  // Live fill: while anything is still generating, re-poll (the GET also nudges
  // the worker), so slots appear as they're produced — review while it runs.
  const anyGenerating = items.some((i) => i.status === "queued" || i.status === "processing");
  useEffect(() => {
    if (!anyGenerating) return;
    const t = setInterval(() => { load(); }, 4000);
    return () => clearInterval(t);
  }, [anyGenerating, load]);

  // Approval is persisted server-side (so the bulk tab can filter approved SKUs).
  const toggleApprove = async (genId: string) => {
    const next = !approved[genId];
    setApproved((prev) => ({ ...prev, [genId]: next })); // optimistic
    try {
      const res = await fetch("/api/qa/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: genId, approved: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setApproved((prev) => ({ ...prev, [genId]: !next })); // revert
      alert("Не вдалося зберегти статус. Спробуй ще.");
    }
  };

  async function act(genId: string, index: number, action: "regen" | "delete" | "reject" | "unreject", scene?: SceneChoice) {
    if (action === "delete" && !confirm("Видалити це фото? Воно також зникне з Google Диску.")) return;
    const key = `${genId}:${index}`;
    const note = action === "regen" ? (noteBySlot[key] ?? "") : undefined;
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await fetch("/api/qa/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Manual regen now HAMMERS via the worker queue (persistent under 429),
        // carrying the correction note baked into the prompt.
        body: JSON.stringify({ generationId: genId, index, action, scene, note, persistent: action === "regen" }),
      });
      const data = await res.json();
      if (!res.ok) {
        // The image may have been saved even though the request reported an error
        // (e.g. a slow regen that finished just as the function timed out). Reload
        // the real server state so a generated photo still shows up.
        alert((data.error || "Не вдалося") + " — оновлюю стан…");
        await load();
        return;
      }
      if (action === "reject" || action === "unreject") { await load(); return; } // server is source of truth
      if (data.persistent) { await load(); return; } // queued → worker fills it, live poll shows progress
      setItems((prev) => prev.map((it) => {
        if (it.id !== genId) return it;
        const slots = it.slots.map((s) =>
          s.index === index
            ? { ...s, url: action === "regen" ? (data.url ?? "") : "", driveUrl: action === "regen" ? (data.driveUrl ?? "") : "" }
            : s
        );
        return { ...it, slots, done: slots.filter((s) => s.url).length };
      }));
    } catch {
      // Network/timeout — the action may still have completed server-side; reload.
      await load();
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(key); return n; });
    }
  }

  // Fill every still-empty slot via the WORKER QUEUE. The worker's multi-pass
  // persistence (pacing + retries across many invocations) rides through 429 far
  // better than a one-shot synchronous regen, which is why a batch reaches 8/8 over
  // p7-p8 passes while a single manual regen keeps losing. The live poll then shows
  // the slots fill in on their own.
  async function genAllMissing(item: Item) {
    const key = `gen:${item.id}`;
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await fetch("/api/qa/requeue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: item.id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(d.error || "Не вдалося поставити в чергу"); return; }
      await load(); // status → queued → live poll fills the slots
    } catch (e) { alert("Мережева помилка: " + (e as Error).message); await load(); }
    finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  }

  // Step-by-step mode: trigger a DRAFT product (worker generates all its angles).
  async function genProduct(genId: string) {
    const key = `gen:${genId}`;
    setBusy((b) => new Set(b).add(key));
    try {
      const res = await fetch(`/api/batch/${batchId}/generate-one`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: genId }),
      });
      const d = await res.json();
      if (!res.ok) { alert(d.error || "Не вдалося запустити"); return; }
      await load(); // status → queued → live poll kicks in
    } catch { await load(); }
    finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  }

  if (loading) {
    return <div className="text-[#6B6560] py-16 text-center">Завантаження…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <Link href="/dashboard/history" className="text-[#E8943A] hover:underline text-sm">← Історія</Link>
        <div className="bg-[#161412] border border-[#2A2723] rounded-xl px-6 py-12 text-center text-[#6B6560]">
          Ця партія порожня або ще не згенерована.
        </div>
      </div>
    );
  }

  const it = items[Math.min(idx, items.length - 1)];
  const totalApproved = items.filter((i) => approved[i.id]).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/dashboard/history" className="text-[#E8943A] hover:underline text-sm">← Історія</Link>
          <h1 className="font-heading text-2xl font-bold text-[#F5F0EB] mt-1">Перевірка партії</h1>
          <p className="text-[#6B6560] text-sm mt-0.5">
            {items.length} товарів · ✅ перевірено {totalApproved}/{items.length}
            {anyGenerating && <span className="text-[#E8943A]"> · 🔄 генерується… (фото доливаються самі)</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {anyGenerating && (
            <button onClick={async () => {
              if (!confirm("Скасувати генерацію цієї партії?")) return;
              try { await fetch(`/api/batch/${batchId}/cancel`, { method: "POST" }); } catch { /* ignore */ }
              await load();
            }} className="bg-red-500/15 hover:bg-red-500/25 text-red-400 text-sm px-3 py-2 rounded-lg">⛔ Скасувати</button>
          )}
          <button onClick={load} className="bg-[#2A2723] hover:bg-[#373330] text-[#F5F0EB] text-sm px-3 py-2 rounded-lg">
            ↻ Оновити
          </button>
        </div>
      </div>

      {/* Product navigation */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          disabled={idx === 0}
          className="bg-[#2A2723] hover:bg-[#373330] disabled:opacity-40 text-[#F5F0EB] text-sm px-3 py-2 rounded-lg"
        >← Попередній</button>
        <select
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          className="bg-[#161412] border border-[#2A2723] text-[#F5F0EB] text-sm px-3 py-2 rounded-lg max-w-[60vw]"
        >
          {items.map((p, i) => (
            <option key={p.id} value={i}>
              {i + 1}. {p.sku || p.productType || "товар"} {approved[p.id] ? "✅" : ""}
            </option>
          ))}
        </select>
        <button
          onClick={() => setIdx((i) => Math.min(items.length - 1, i + 1))}
          disabled={idx >= items.length - 1}
          className="bg-[#2A2723] hover:bg-[#373330] disabled:opacity-40 text-[#F5F0EB] text-sm px-3 py-2 rounded-lg"
        >Наступний →</button>
        <span className="text-[#6B6560] text-sm ml-1">{idx + 1} / {items.length}</span>
      </div>

      {/* Current product */}
      <div className="bg-[#161412] border border-[#2A2723] rounded-xl p-5 space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-[#F5F0EB] font-medium">{it.sku || "—"} · {it.productType || "—"}</p>
            <p className="text-[#6B6560] text-xs mt-0.5">
              {it.done}/{it.total} фото · {it.status === "draft" ? "⬜ не згенеровано" : it.status === "done" ? "Готово" : it.status === "error" ? "Помилка" : it.status === "queued" || it.status === "processing" ? "🔄 генерується…" : it.status}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {it.status === "draft" ? (
              <button
                onClick={() => genProduct(it.id)}
                disabled={busy.has(`gen:${it.id}`)}
                className="text-sm font-semibold px-4 py-2 rounded-lg bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-50 text-[#0C0B0A]"
              >▶ Згенерувати всі ракурси ({it.total})</button>
            ) : it.slots.some((s) => !s.url && !s.rejected) && (
              <button
                onClick={() => genAllMissing(it)}
                disabled={busy.has(`gen:${it.id}`)}
                title="Доганяє відсутні кадри через чергу воркера — багато проходів із ретраями, стійко до 429 (надійніше за поодиноку перегенерацію)"
                className="text-sm font-medium px-3 py-2 rounded-lg bg-[#E8943A]/15 text-[#E8943A] border border-[#E8943A]/40 hover:bg-[#E8943A]/25 disabled:opacity-50"
              >🔄 Доганяти відсутні ({it.slots.filter((s) => !s.url && !s.rejected).length})</button>
            )}
            <button
              onClick={() => toggleApprove(it.id)}
              className={`text-sm font-medium px-4 py-2 rounded-lg ${
                approved[it.id]
                  ? "bg-green-500/20 text-green-400 border border-green-500/40"
                  : "bg-[#2A2723] hover:bg-[#373330] text-[#F5F0EB]"
              }`}
            >{approved[it.id] ? "✅ Перевірено" : "Позначити перевіреним"}</button>
            {idx < items.length - 1 && (
              <button
                onClick={() => { if (!approved[it.id]) toggleApprove(it.id); setIdx((i) => Math.min(items.length - 1, i + 1)); }}
                className="text-sm font-medium px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white"
              >✅ ОК і далі →</button>
            )}
          </div>
        </div>

        {/* Originals */}
        <div>
          <p className="text-[#6B6560] text-xs uppercase tracking-wide mb-2">Оригінали (референс)</p>
          {it.originals.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {it.originals.map((u, i) => (
                <a key={i} href={u} target="_blank" rel="noopener noreferrer"
                   className="aspect-[3/4] rounded-lg overflow-hidden border border-[#2A2723] hover:border-[#E8943A] block bg-[#0C0B0A]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="w-full h-full object-cover" loading="lazy" />
                </a>
              ))}
            </div>
          ) : <p className="text-[#6B6560] text-sm">Немає оригіналів.</p>}
        </div>

        {/* Generated */}
        <div>
          <p className="text-[#6B6560] text-xs uppercase tracking-wide mb-2">Згенеровані</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {it.slots.map((s) => {
              const slotKey = `${it.id}:${s.index}`;
              const isBusy = busy.has(slotKey);
              // On-model default = a real scene (studio + person ref copies the model); object default = studio.
              const scene = sceneBySlot[slotKey] ?? (it.season ? "seasonal" : (it.onModel ? "free" : "studio"));
              return (
                <div key={s.index} className={`space-y-1.5 ${s.rejected ? "opacity-70" : ""}`}>
                  <div className="aspect-[3/4] rounded-lg overflow-hidden border border-[#2A2723] bg-[#0C0B0A] relative">
                    {isBusy && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[#E8943A] text-xs z-10">
                        Обробка…
                      </div>
                    )}
                    {s.rejected ? (
                      <div className="w-full h-full flex items-center justify-center text-red-400 text-xs text-center px-2">✕ Відхилено</div>
                    ) : s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={s.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </a>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#6B6560] text-xs text-center px-2">
                        Немає фото
                      </div>
                    )}
                  </div>
                  <p className="text-[#6B6560] text-[11px] truncate" title={s.angle}>
                    {s.angle}{s.driveUrl ? " · ☁" : ""}
                  </p>

                  {s.rejected ? (
                    <button
                      onClick={() => act(it.id, s.index, "unreject")}
                      disabled={isBusy}
                      className="w-full bg-[#2A2723] hover:bg-[#373330] disabled:opacity-40 text-[#F5F0EB] text-[11px] py-1.5 rounded"
                    >↩ Повернути</button>
                  ) : (
                    <>
                      <input
                        value={noteBySlot[slotKey] ?? ""}
                        onChange={(e) => setNoteBySlot((m) => ({ ...m, [slotKey]: e.target.value }))}
                        placeholder="✎ що не так у цьому ракурсі…"
                        className="w-full bg-[#0C0B0A] border border-[#2A2723] focus:border-[#E8943A] focus:outline-none text-[#F5F0EB] text-[10px] rounded px-1.5 py-1"
                        title="Примітка додається до промту саме цього ракурсу при ↻"
                      />
                      <select
                        value={scene}
                        onChange={(e) => setSceneBySlot((m) => ({ ...m, [slotKey]: e.target.value as SceneChoice }))}
                        className="w-full bg-[#0C0B0A] border border-[#2A2723] text-[#6B6560] text-[10px] rounded px-1 py-1"
                        title="Сцена для перегенерації"
                      >
                        {(["studio", "seasonal", "free"] as SceneChoice[]).map((sc) => (
                          <option key={sc} value={sc}>🎬 {SCENE_LABEL[sc]}</option>
                        ))}
                      </select>
                      <div className="flex gap-1">
                        <button
                          onClick={() => act(it.id, s.index, "regen", scene)}
                          disabled={isBusy}
                          className="flex-1 bg-[#2A2723] hover:bg-[#373330] disabled:opacity-40 text-[#F5F0EB] text-[11px] py-1.5 rounded"
                        >↻ {s.url ? "Перегенерувати" : "Згенерувати"}</button>
                        {s.url && (
                          <button
                            onClick={() => act(it.id, s.index, "delete")}
                            disabled={isBusy}
                            className="bg-red-500/15 hover:bg-red-500/25 disabled:opacity-40 text-red-400 text-[11px] px-2 py-1.5 rounded"
                            title="Видалити (також з Google Диску)"
                          >🗑</button>
                        )}
                        <button
                          onClick={() => act(it.id, s.index, "reject")}
                          disabled={isBusy}
                          className="bg-[#2A2723] hover:bg-red-500/20 disabled:opacity-40 text-[#6B6560] hover:text-red-400 text-[11px] px-2 py-1.5 rounded"
                          title="Відхилити: цей кадр неможливо згенерувати (не рахувати як відсутній)"
                        >✕</button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
