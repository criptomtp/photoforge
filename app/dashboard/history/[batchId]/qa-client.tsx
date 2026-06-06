"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Slot { index: number; angle: string; url: string; driveUrl: string }
interface Item {
  id: string; sku: string; productType: string; status: string;
  done: number; total: number; originals: string[]; slots: Slot[];
}

const APPROVE_KEY = (batchId: string) => `pf_qa_approved_${batchId}`;

export default function QAClient({ batchId }: { batchId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null); // `${genId}:${index}`
  const [approved, setApproved] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/qa/${batchId}`);
      const data = await res.json();
      if (Array.isArray(data.items)) setItems(data.items);
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(APPROVE_KEY(batchId));
      if (raw) setApproved(JSON.parse(raw));
    } catch { /* ignore */ }
  }, [batchId]);

  const toggleApprove = (genId: string) => {
    setApproved((prev) => {
      const next = { ...prev, [genId]: !prev[genId] };
      try { localStorage.setItem(APPROVE_KEY(batchId), JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  async function act(genId: string, index: number, action: "regen" | "delete") {
    if (action === "delete" && !confirm("Видалити це фото? Воно також зникне з Google Диску.")) return;
    setBusy(`${genId}:${index}`);
    try {
      const res = await fetch("/api/qa/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: genId, index, action }),
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
      setBusy(null);
    }
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
          </p>
        </div>
        <button onClick={load} className="bg-[#2A2723] hover:bg-[#373330] text-[#F5F0EB] text-sm px-3 py-2 rounded-lg">
          ↻ Оновити
        </button>
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
              {it.done}/{it.total} фото · {it.status === "done" ? "Готово" : it.status === "error" ? "Помилка" : it.status}
            </p>
          </div>
          <button
            onClick={() => toggleApprove(it.id)}
            className={`text-sm font-medium px-4 py-2 rounded-lg ${
              approved[it.id]
                ? "bg-green-500/20 text-green-400 border border-green-500/40"
                : "bg-[#2A2723] hover:bg-[#373330] text-[#F5F0EB]"
            }`}
          >{approved[it.id] ? "✅ Перевірено" : "Позначити перевіреним"}</button>
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
              const isBusy = busy === `${it.id}:${s.index}`;
              return (
                <div key={s.index} className="space-y-1.5">
                  <div className="aspect-[3/4] rounded-lg overflow-hidden border border-[#2A2723] bg-[#0C0B0A] relative">
                    {isBusy && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[#E8943A] text-xs z-10">
                        Обробка…
                      </div>
                    )}
                    {s.url ? (
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
                  <div className="flex gap-1">
                    <button
                      onClick={() => act(it.id, s.index, "regen")}
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
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
