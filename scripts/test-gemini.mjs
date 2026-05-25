// Standalone Gemini API key tester. No npm deps.
//
// Usage:
//   node --env-file=.env.local scripts/test-gemini.mjs            (platform key from DB? — won't read DB; uses env)
//   node --env-file=.env.local scripts/test-gemini.mjs <API_KEY>  (override via arg)
//   GEMINI_API_KEY=AIza... node scripts/test-gemini.mjs
//
// Runs two real calls against Google AI Studio:
//   1. gemini-2.5-flash       — text-only (cheap)
//   2. gemini-2.5-flash-image-preview — image generation (matches lib/gemini.ts)
//
// Prints HTTP status, usage tokens (if returned), and a short response excerpt.
// Returns exit code 1 if any call fails — easy to grep in CI.

const KEY =
  process.argv[2] ||
  process.env.GEMINI_API_KEY ||
  process.env.PLATFORM_GEMINI_API_KEY ||
  process.env.GOOGLE_AI_STUDIO_KEY;

if (!KEY) {
  console.error("❌ No API key. Pass as arg or set GEMINI_API_KEY in .env.local");
  console.error("   Try: node --env-file=.env.local scripts/test-gemini.mjs");
  process.exit(2);
}

const STUDIO_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// 1×1 transparent PNG (smallest possible valid PNG)
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

async function callModel(model, body, useHeader = false) {
  const t0 = Date.now();
  const url = useHeader
    ? `${STUDIO_BASE}/${model}:generateContent`
    : `${STUDIO_BASE}/${model}:generateContent?key=${KEY}`;
  const headers = { "Content-Type": "application/json" };
  if (useHeader) headers["x-goog-api-key"] = KEY;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, ms, json, raw: text };
}

async function testText() {
  console.log("\n── 1. Text generation (gemini-2.5-flash) ─────────────────");
  const result = await callModel("gemini-2.5-flash", {
    contents: [{ role: "user", parts: [{ text: "Say 'pong' in one word." }] }],
  });
  console.log(`   HTTP ${result.status}  •  ${result.ms} ms  •  ${fmtBytes(result.raw.length)}`);
  if (!result.ok) {
    console.error(`   ❌ ${result.json?.error?.message ?? result.raw.slice(0, 400)}`);
    return false;
  }
  const reply = result.json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(no text)";
  const usage = result.json?.usageMetadata ?? {};
  console.log(`   ↳ reply:  ${reply.trim().slice(0, 80)}`);
  console.log(`   ↳ tokens: prompt=${usage.promptTokenCount ?? "?"}  output=${usage.candidatesTokenCount ?? "?"}  total=${usage.totalTokenCount ?? "?"}`);
  return true;
}

async function testImage() {
  console.log("\n── 2. Image generation (gemini-2.5-flash-image-preview) ──");
  const result = await callModel(
    "gemini-2.5-flash-image-preview",
    {
      contents: [
        {
          parts: [
            { text: "Generate a single small abstract orange gradient. Reply with just ГОТОВО after the image." },
            { inline_data: { mime_type: "image/png", data: TINY_PNG_B64 } },
          ],
        },
      ],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    },
    true // image gen uses x-goog-api-key header
  );
  console.log(`   HTTP ${result.status}  •  ${result.ms} ms  •  ${fmtBytes(result.raw.length)}`);
  if (!result.ok) {
    console.error(`   ❌ ${result.json?.error?.message ?? result.raw.slice(0, 400)}`);
    return false;
  }
  const parts = result.json?.candidates?.[0]?.content?.parts ?? [];
  const imgPart = parts.find((p) => p.inline_data?.mime_type?.startsWith("image/"));
  const usage = result.json?.usageMetadata ?? {};
  if (!imgPart) {
    console.error("   ❌ No image part in response. Parts:", parts.map((p) => Object.keys(p)));
    return false;
  }
  const imgBytes = Math.floor((imgPart.inline_data.data.length * 3) / 4);
  console.log(`   ↳ image:  ${imgPart.inline_data.mime_type}, ~${fmtBytes(imgBytes)}`);
  console.log(`   ↳ tokens: prompt=${usage.promptTokenCount ?? "?"}  output=${usage.candidatesTokenCount ?? "?"}  total=${usage.totalTokenCount ?? "?"}`);
  return true;
}

console.log(`Key prefix: ${KEY.slice(0, 8)}…${KEY.slice(-4)}   (length ${KEY.length})`);

const textOk = await testText();
const imageOk = await testImage();

console.log("\n──────────────────────────────────────────────────────────");
console.log(`Text:  ${textOk ? "✅" : "❌"}`);
console.log(`Image: ${imageOk ? "✅" : "❌"}`);
process.exit(textOk && imageOk ? 0 : 1);
