"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Folder { id: string; name: string }

export default function FolderPicker({
  onPick,
  onClose,
}: {
  onPick: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const [stack, setStack] = useState<{ id: string; name: string }[]>([{ id: "root", name: "Мій диск" }]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<null | "reconnect" | "connect" | "error">(null);
  const current = stack[stack.length - 1];

  const load = useCallback(async (parentId: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/drive/folders?parentId=${encodeURIComponent(parentId)}`);
      const d = await res.json();
      if (!res.ok) {
        setError(d.error === "reconnect_google" ? "reconnect" : d.error === "google_not_connected" ? "connect" : "error");
        setFolders([]); return;
      }
      setFolders(d.folders ?? []);
    } catch { setError("error"); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(current.id); }, [current.id, load]);

  async function createFolder() {
    const name = prompt("Назва нової папки:");
    if (!name?.trim()) return;
    const res = await fetch("/api/drive/folders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parentId: current.id }),
    });
    const d = await res.json();
    if (!res.ok) { alert(d.error === "reconnect_google" ? "Перепідключи Google у Налаштуваннях" : d.error || "Не вдалося"); return; }
    await load(current.id);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#161412] border border-[#2A2723] rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#2A2723]">
          <h3 className="text-[#F5F0EB] font-medium">📁 Обрати папку на Google Диску</h3>
          <button onClick={onClose} className="text-[#6B6560] hover:text-[#F5F0EB]">✕</button>
        </div>

        {/* Breadcrumb */}
        <div className="px-4 py-2 text-xs text-[#6B6560] flex items-center gap-1 flex-wrap border-b border-[#2A2723]">
          {stack.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1">
              {i > 0 && <span>/</span>}
              <button onClick={() => setStack((s) => s.slice(0, i + 1))}
                className={i === stack.length - 1 ? "text-[#E8943A]" : "hover:text-[#F5F0EB]"}>{c.name}</button>
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-2 min-h-[180px]">
          {loading ? (
            <div className="text-[#6B6560] text-sm text-center py-10">Завантаження…</div>
          ) : error ? (
            <div className="text-center py-8 px-4 text-sm">
              <p className="text-red-400 mb-2">
                {error === "connect" ? "Google Диск не підключено." : error === "reconnect"
                  ? "Потрібно ПЕРЕпідключити Google — ми розширили доступ, щоб показувати дерево папок."
                  : "Не вдалося завантажити папки."}
              </p>
              {(error === "reconnect" || error === "connect") && (
                <Link href="/dashboard/settings" className="text-[#E8943A] hover:underline">→ Перейти в Налаштування та підключити Google</Link>
              )}
            </div>
          ) : folders.length === 0 ? (
            <div className="text-[#6B6560] text-sm text-center py-10">Тут немає вкладених папок.</div>
          ) : (
            <div className="space-y-1">
              {folders.map((f) => (
                <button key={f.id} onClick={() => setStack((s) => [...s, { id: f.id, name: f.name }])}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#1E1C19] text-[#F5F0EB] text-sm flex items-center justify-between group">
                  <span>📁 {f.name}</span>
                  <span className="text-[#6B6560] group-hover:text-[#E8943A]">відкрити →</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-[#2A2723] flex items-center justify-between gap-2 flex-wrap">
          <button onClick={createFolder} disabled={!!error}
            className="text-sm text-[#E8943A] hover:underline disabled:opacity-40">➕ Нова папка тут</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg text-[#6B6560] hover:text-[#F5F0EB]">Скасувати</button>
            <button onClick={() => onPick(current.id, stack.map((c) => c.name).join("/"))} disabled={!!error}
              className="text-sm px-4 py-2 rounded-lg bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] font-medium disabled:opacity-40">
              ✓ Обрати «{current.name}»
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
