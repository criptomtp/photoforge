// Client-safe constants — no DB / server imports. Shared between UI and API.

export interface AngleDef {
  id: string;
  label: string;        // human-readable, also used as ZIP filename + alt text
  desc: string;         // injected into the Gemini system prompt
}

export const ANGLE_DEFS: readonly AngleDef[] = [
  { id: "fullbody_front",       label: "Full-body front",     desc: "Повний зріст спереду, товар добре видно." },
  { id: "fullbody_side",        label: "Full-body side",      desc: "Повний зріст збоку." },
  { id: "fullbody_back",        label: "Full-body back",      desc: "Повний зріст ззаду, видно силует і посадку товару." },
  { id: "three_quarter_front",  label: "3/4 front",           desc: "Ракурс 3/4 спереду, акцент на ключових деталях." },
  { id: "three_quarter_back",   label: "3/4 back",            desc: "Ракурс 3/4 ззаду, акцент на спинці, швах і посадці." },
  { id: "closeup",              label: "Close-up detail",     desc: "Великий план важливої деталі (текстура, шви, логотип, фурнітура)." },
  { id: "action",                label: "Medium action shot",  desc: "Середній план в русі / дії." },
  { id: "creative",             label: "Creative shot",       desc: "Креативний, але реалістичний кадр." },
] as const;

export const ANGLE_IDS = ANGLE_DEFS.map((a) => a.id);

export interface AnglePreset {
  id: string;
  label: string;
  angles: readonly string[];
}

export const PRESETS: readonly AnglePreset[] = [
  { id: "full",       label: "Full set — 8 ракурсів",       angles: ANGLE_DEFS.map((a) => a.id) },
  { id: "quick3",     label: "Quick — front + back + close-up", angles: ["fullbody_front", "fullbody_back", "closeup"] },
  { id: "front_only", label: "Тільки Full-body front",      angles: ["fullbody_front"] },
] as const;

// ── Token economics & quality tiers ──────────────────────────────────────────
export const TOKEN_COSTS = {
  prompt_gen: 0.10,                  // one prompt-generation call (Gemini text)
  image_gen:  0.50,                  // per image at Standard quality
} as const;

export type QualityId = "standard" | "plus" | "pro";

export interface QualityTier {
  id: QualityId;
  label: string;
  desc: string;
  model: string;            // Gemini image model id
  location: string;         // Vertex location: "us-central1" (regional) or "global"
  tokenMultiplier: number;  // image cost relative to Standard
}

// Standard runs today on Vertex us-central1. Plus/Pro are Gemini 3 image models —
// GLOBAL-only and may require a Google allowlist on the project.
export const QUALITY_TIERS: Record<QualityId, QualityTier> = {
  standard: { id: "standard", label: "Standard", desc: "Базова якість", model: "gemini-2.5-flash-image", location: "us-central1", tokenMultiplier: 1 },
  plus:     { id: "plus",     label: "Plus",     desc: "Краще, до 4K (Nano Banana 2)", model: "gemini-3.1-flash-image", location: "global", tokenMultiplier: 2 },
  pro:      { id: "pro",      label: "Pro",      desc: "Топ + точний текст/лого", model: "gemini-3-pro-image", location: "global", tokenMultiplier: 3 },
};

export function qualityTier(id?: string): QualityTier {
  return QUALITY_TIERS[(id as QualityId)] ?? QUALITY_TIERS.standard;
}

export function costForAngles(angleCount: number, tokenMultiplier = 1): number {
  return TOKEN_COSTS.prompt_gen + TOKEN_COSTS.image_gen * tokenMultiplier * angleCount;
}

export const FULL_RUN_COST = costForAngles(ANGLE_DEFS.length); // 0.10 + 0.50*8 = 4.10

// Net tokens actually charged for a run: prompt cost + per-image cost for the
// images that SUCCEEDED. Full cost is reserved up-front; failures are refunded.
export function netCostForRun(angleCount: number, imagesGenerated: number, tokenMultiplier = 1): number {
  if (imagesGenerated <= 0) return 0;
  return TOKEN_COSTS.prompt_gen + TOKEN_COSTS.image_gen * tokenMultiplier * Math.min(imagesGenerated, angleCount);
}

// How much of the up-front reserve to give back, given how many images succeeded.
export function refundForRun(angleCount: number, imagesGenerated: number, tokenMultiplier = 1): number {
  const refund = costForAngles(angleCount, tokenMultiplier) - netCostForRun(angleCount, imagesGenerated, tokenMultiplier);
  return refund > 0 ? refund : 0;
}

export function angleById(id: string): AngleDef | undefined {
  return ANGLE_DEFS.find((a) => a.id === id);
}

// Resolve a list of IDs to AngleDefs in the order of the canonical list,
// dropping unknown IDs.
export function resolveAngles(ids: readonly string[]): AngleDef[] {
  const set = new Set(ids);
  return ANGLE_DEFS.filter((a) => set.has(a.id));
}
