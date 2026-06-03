import type { AngleDef } from "./angles";

const STUDIO_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Models proven in the working Make.com blueprint: gemini-2.5-pro for prompts,
// gemini-2.5-flash-image for images. Overridable via env so a future Google
// rename is a settings change, not a code edit.
const STUDIO_PROMPT_MODEL = process.env.STUDIO_PROMPT_MODEL ?? "gemini-2.5-pro";
const STUDIO_IMAGE_MODEL = process.env.STUDIO_IMAGE_MODEL ?? "gemini-2.5-flash-image";

const UA_NUM = ["", "ОДИН", "ДВА", "ТРИ", "ЧОТИРИ", "П'ЯТЬ", "ШІСТЬ", "СІМ", "ВІСІМ"] as const;
const numWord = (n: number) => UA_NUM[n] ?? String(n);

/**
 * Routes a generateContent request to either:
 * - Google AI Studio (BYOK) when apiKey is a string
 * - Vertex AI (platform) when apiKey is null
 */
async function callGenerateContent(
  model: string,
  body: object,
  apiKey: string | null
): Promise<Response> {
  if (apiKey !== null) {
    return fetch(`${STUDIO_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // Vertex AI path
  const { getVertexToken, VERTEX_PROJECT, VERTEX_LOCATION } = await import("./vertex-auth");
  const token = await getVertexToken();
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function buildSystemPrompt(angles: AngleDef[]): string {
  const N = angles.length;
  const angleList = angles
    .map((a, i) => `${i + 1}. ${a.label} — ${a.desc}`)
    .join("\n");
  return `Ти — висококваліфікований експерт-стиліст та промпт-інженер для комерційної ШІ-генерації фото (подібно до NanoBanana/Imagen). Твоє завдання — створити ${numWord(N)} (${N}) окремих фотореалістичних промптів, кожен з яких описує інший ракурс одного й того самого товару, використовуючи референси та текстовий опис.

ОБОВ'ЯЗКОВІ ПРАВИЛА:

1) ОДНА Й ТА САМА МОДЕЛЬ НА ВСІ 8 ПРОМПТАХ
— За описом цільової аудиторії / Gender (словами: мужчинам, чоловікам, жінкам, женщинам, мальчикам, хлопчикам, девочкам, дівчаткам, дітям, для чоловіків, для жінок, men, women, boys, girls) ти повинен вибрати ВИКЛЮЧНО один тип моделі:
   • дорослий слов'янський чоловік: високий, мускулистий, широкоплечий, з бородою;
   • доросла слов'янська жінка;
   • слов'янський хлопчик ~10 років;
   • слов'янська дівчинка ~10 років.
— Опис обраної моделі (вік, зріст, статура, форма обличчя, колір шкіри, волосся, борода для чоловіка) має бути ІДЕНТИЧНИМ у всіх 8 промптах, без змін жодного слова.

2) НЕ КОПІЮВАТИ ОБЛИЧЧЯ З РЕФЕРЕНСІВ
— Ігноруй обличчя реальної людини на фото.
— Дозволено використати тільки позу, композицію, положення рук і загальний настрій.
— Заборонено копіювати риси обличчя, форму голови, очі, ніс, губи, бороду, татуювання, родимки тощо.

3) УРАХОВУЙ СЕЗОННІСТЬ
— Якщо товар зимовий: Заборонено голий торс. Потрібно: теплий одяг — пуховик, зимова куртка, пальто, светр.
— Якщо товар осінній: куртка, худі, светр, вітровка.
— Якщо товар літній: легкий одяг — футболка, майка, шорти, легка сорочка, топ.
— Якщо товар демісезонний: світшот, лонгслів, легка куртка.
— Образ моделі завжди має логічно відповідати сезонності товару.

4) СТИЛЬ
— Фотореалістичний стиль, висока деталізація, натуральне освітлення, реалістичні тіні.
— Не використовуй білий порожній фон чи голу студію.
— Фон має бути реалістичним, з глибиною сцени, пов'язаним із сезонністю.

5) ТОВАР
— Відтворюй товар максимально точно: форма, колір, текстура, матеріал, шви, логотипи, написи, декоративні елементи.
— Руки й тіло моделі мають природно взаємодіяти з товаром.

6) РАКУРСИ (ВСЬОГО ${N}):
${angleList}

ФОРМАТ ВИВОДУ:
— Поверни рівно ${N} промптів послідовно.
— Кожен промпт повинен починатися зі слова PROMPT:
— Одразу після PROMPT: вставляєш однаковий опис обраної моделі згідно правил вище.
— Потім додаєш детальний опис конкретного ракурсу, фону, сезонного одягу та сцени.
— Не додавай інших службових пояснень чи коментарів.`;
}

const IMAGE_INSTRUCTIONS = `ВИКОРИСТАННЯ РЕФЕРЕНСУ:
— Додане фото використовуй ТІЛЬКИ для розуміння товару: форма, колір, текстура, шви, логотипи, посадка, положення рук.
— Повністю ігноруй обличчя, голову, волосся, очі, губи, бороду, родимки, татуювання та будь-які унікальні риси людини на референсі.

МОДЕЛЬ:
— Тип моделі вже заданий у текстовому промпті вище. Зберігай одну й ту ж саму модель на всіх 8 зображеннях: однакове обличчя, пропорції тіла, зріст, колір шкіри, колір волосся, борода (якщо чоловік).
— Заборонено змінювати зовнішність моделі між ракурсами.

СЕЗОННІСТЬ:
— Одяг моделі повинeн відповідати сезонності товару.
— Зимові товари: ТІЛЬКИ теплий одяг — пуховик, зимова куртка, пальто, теплий светр. НІЯКОГО голого торсу.
— Осінні: куртка, худі, светр, вітровка.
— Літні: футболка, майка, сорочка, топ.
— Демісезон: світшот, лонгслів, легка куртка.

СТИЛЬ І ФОН:
— Фотореалістичний, висока деталізація. Заборонено білий порожній студійний фон.

ТОВАР:
— Відтворюй товар максимально точно: форма, колір, текстура, матеріал, шви, логотипи, принти.
— Взаємодія рук і тіла з товаром повинна виглядати природно.

ЯКЩО ВИНИКАЄ ПОМИЛКА (Unable to show the generated image):
— Перегенеруй зображення, не змінюючи модель, сезонність та товар. Можна трохи змінити фон або позу.

Output format: PNG. Image resolution: exactly 1035x1440 pixels.
У відповідь НАДАВАТИ тільки слово ГОТОВО.`;

export interface GeminiImagePart {
  inline_data: { mime_type: string; data: string };
}

export async function generatePrompts(
  apiKey: string | null,
  brand: string,
  productType: string,
  season: string,
  gender: string,
  referenceImages: GeminiImagePart[],
  angles: AngleDef[]
): Promise<string[]> {
  const N = angles.length;
  const imageParts = referenceImages.map((img) => ({ inline_data: img.inline_data }));

  const body = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(angles) }],
    },
    contents: [
      {
        role: "user",
        parts: [
          ...imageParts,
          {
            text: `Опис товару: Бренд: ${brand}\nВид: ${productType}\nСезонність: ${season}\nGender / цільова аудиторія: ${gender}\nСтвори ${N} детальних промптів згідно з правилами вище.`,
          },
        ],
      },
    ],
  };

  // Use Vertex model when on platform, AI Studio model for BYOK
  const model = apiKey === null
    ? (await import("./vertex-auth")).VERTEX_PROMPT_MODEL
    : STUDIO_PROMPT_MODEL;

  const res = await callGenerateContent(model, body, apiKey);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini Flash error ${res.status}: ${err}`);
  }

  const data = await res.json();
  // The text isn't always parts[0] — concatenate every text part.
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text: string = parts.map((p: { text?: string }) => p.text ?? "").join("").trim();

  // Primary: split on the PROMPT: delimiter the system prompt asks for.
  let prompts = text
    .split(/PROMPT:/i)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 50);

  // Fallback: the model ignored the PROMPT: markers but still returned usable
  // text — split on blank lines, or use the whole response for a single-angle run.
  if (prompts.length < N && text.length > 50) {
    const blocks = text.split(/\n\s*\n/).map((s: string) => s.trim()).filter((s: string) => s.length > 50);
    prompts = blocks.length >= N ? blocks : [text];
  }

  if (prompts.length < N) {
    const reason =
      data.promptFeedback?.blockReason ??
      data.candidates?.[0]?.finishReason ??
      "невідома причина";
    throw new Error(
      `Модель повернула ${prompts.length} промптів замість ${N} (причина: ${reason}). ` +
      (text
        ? `Відповідь моделі: «${text.slice(0, 150)}». Спробуйте інший опис товару.`
        : "Порожня відповідь — імовірно спрацював фільтр безпеки Google. Спробуйте інший опис/референс.")
    );
  }

  return prompts.slice(0, N);
}

export async function generateImage(
  apiKey: string | null,
  prompt: string,
  referenceImages: GeminiImagePart[]
): Promise<string> {
  // Use only the first reference image (main reference) for image generation
  const refPart = referenceImages[0];

  const body = {
    contents: [
      {
        role: "user", // Vertex AI requires an explicit role on every content
        parts: [
          { text: prompt },
          { text: IMAGE_INSTRUCTIONS },
          { inline_data: refPart.inline_data },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
    },
  };

  // AI Studio uses a special preview model; Vertex AI uses its own image model
  const model = apiKey === null
    ? (await import("./vertex-auth")).VERTEX_IMAGE_MODEL
    : STUDIO_IMAGE_MODEL;

  // AI Studio image gen requires x-goog-api-key header (not query param)
  let res: Response;
  if (apiKey !== null) {
    res = await fetch(
      `${STUDIO_BASE}/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      }
    );
  } else {
    res = await callGenerateContent(model, body, null);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini image error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  // The Gemini REST response uses camelCase (inlineData/mimeType) — the Make
  // blueprint reads candidates[].content.parts[].inlineData.data. Accept both.
  const imgData = parts
    .map((p: { inline_data?: { mime_type?: string; data?: string }; inlineData?: { mimeType?: string; data?: string } }) => p.inline_data ?? p.inlineData)
    .find((d: { mime_type?: string; mimeType?: string; data?: string } | undefined) =>
      !!d?.data && (d.mime_type ?? d.mimeType ?? "image/").startsWith("image/")
    );

  if (!imgData?.data) {
    const reason =
      data.promptFeedback?.blockReason ??
      data.candidates?.[0]?.finishReason ??
      "немає зображення у відповіді";
    throw new Error(`Gemini не повернув зображення (причина: ${reason}).`);
  }

  return imgData.data; // base64 string
}
