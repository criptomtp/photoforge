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

// ── Token economics ──────────────────────────────────────────────────────────
export const TOKEN_COSTS = {
  prompt_gen: 0.10,                  // one prompt-generation call (Gemini Flash text)
  image_gen:  0.50,                  // per image (Gemini Flash Image)
} as const;

export function costForAngles(angleCount: number): number {
  return TOKEN_COSTS.prompt_gen + TOKEN_COSTS.image_gen * angleCount;
}

export const FULL_RUN_COST = costForAngles(ANGLE_DEFS.length); // 0.10 + 0.50*8 = 4.10

// Net tokens actually charged for a run: the prompt cost plus per-image cost for
// SUCCESSFUL images only. The full cost is reserved up-front (costForAngles) and
// failed images are refunded. Zero successful images ⇒ nothing is charged.
export function netCostForRun(angleCount: number, imagesGenerated: number): number {
  if (imagesGenerated <= 0) return 0;
  return TOKEN_COSTS.prompt_gen + TOKEN_COSTS.image_gen * Math.min(imagesGenerated, angleCount);
}

// How much of the up-front reserve to give back, given how many images succeeded.
export function refundForRun(angleCount: number, imagesGenerated: number): number {
  const refund = costForAngles(angleCount) - netCostForRun(angleCount, imagesGenerated);
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
