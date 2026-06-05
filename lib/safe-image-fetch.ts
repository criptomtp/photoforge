import dns from "node:dns/promises";
import net from "node:net";
import type { GeminiImagePart } from "./gemini";

// SSRF defence: resolve DNS + reject private/internal targets, follow redirects
// MANUALLY re-checking each hop (mitigates DNS-rebinding & 302→metadata).
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
  const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (m) return isPrivateIp(m[1]);
  return false;
}
async function hostResolvesPublic(host: string): Promise<boolean> {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}
async function safeFetch(url: string, depth = 0): Promise<Response | null> {
  if (depth > 3) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!(await hostResolvesPublic(u.hostname))) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
    clearTimeout(t);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      return safeFetch(new URL(loc, url).toString(), depth + 1);
    }
    return res;
  } catch { clearTimeout(t); return null; }
}

export async function fetchImageAsPart(url: string): Promise<GeminiImagePart | null> {
  const res = await safeFetch(url);
  if (!res || !res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 12_000_000) return null;
  const ct = res.headers.get("content-type") ?? "";
  return { inline_data: { mime_type: ct.startsWith("image/") ? ct : "image/jpeg", data: buf.toString("base64") } };
}
