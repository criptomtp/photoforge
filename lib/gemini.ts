import type { AngleDef } from "./angles";
import type { Category } from "./categories";

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
  apiKey: string | null,
  location?: string
): Promise<Response> {
  if (apiKey !== null) {
    return fetch(`${STUDIO_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // Vertex AI path. Gemini 3 image models (Nano Banana 2 / Pro) are GLOBAL-only
  // and use the non-prefixed host aiplatform.googleapis.com; regional models
  // (e.g. gemini-2.5-flash-image in us-central1) use {location}-aiplatform...
  const { getVertexToken, VERTEX_PROJECT, VERTEX_LOCATION } = await import("./vertex-auth");
  const loc = location ?? VERTEX_LOCATION;
  const token = await getVertexToken();
  const host = loc === "global"
    ? "https://aiplatform.googleapis.com"
    : `https://${loc}-aiplatform.googleapis.com`;
  const url = `${host}/v1/projects/${VERTEX_PROJECT}/locations/${loc}/publishers/google/models/${model}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function buildSystemPrompt(
  angles: AngleDef[],
  backgroundMode: "catalog" | "lifestyle",
  cat: Category
): string {
  const N = angles.length;
  const num = numWord(N);
  const angleList = angles
    .map((a, i) => `${i + 1}. ${a.label} — ${a.desc}`)
    .join("\n");

  const bgRule =
    backgroundMode === "lifestyle"
      ? `— РЕЖИМ LIFESTYLE: реалістична сцена з глибиною, що відповідає контексту (вулиця, інтер'єр, природа). Фон не захаращений, без сторонніх людей, тексту, брендів і логотипів. Товар лишається головним об'єктом і повністю в фокусі.`
      : `— РЕЖИМ КАТАЛОГ (для картки маркетплейсу): чистий, рівний, нейтральний фон — світло-сірий або м'який градієнт студійного циклорами (seamless). БЕЗ сторонніх об'єктів, тексту, реквізиту, інших людей. Фон не повинен конкурувати з товаром. Дозволена легка, м'яка тінь під об'єктом.`;

  // Rule 1: subject. On-model categories get the model character-sheet rules;
  // product-only categories (object) forbid a human model entirely.
  const subjectRules = cat.onModel
    ? `1) СУБ'ЄКТ І МОДЕЛЬ — ОДНА Й ТА САМА ЛЮДИНА НА ВСІХ ${N} ПРОМПТАХ
— ${cat.subjectBlock}
${cat.needsGender
        ? `— За статтю / Gender (men/women/boys/girls) обери ВИКЛЮЧНО ОДИН тип моделі: дорослий чоловік (природна спортивна, НЕ бодібілдерська статура, доглянуте нейтральне обличчя, коротка стрижка, борода коротка/відсутня) / доросла жінка (природна статура, нейтральне доглянуте обличчя) / хлопчик ~10 р. / дівчинка ~10 р.\n`
        : `— Якщо потрібна модель — доросла людина з нейтральною доглянутою зовнішністю, природною статурою. Стать обери так, щоб товар виглядав доречно.\n`
      }— Модель звичайної, «середньостатистичної» статури; акцент завжди на ТОВАРІ, а не на моделі.
— Склади детальний фіксований "character sheet" моделі (вік, статура, форма обличчя, відтінок шкіри, волосся, борода якщо є) і повторюй його СЛОВО-В-СЛОВО у всіх ${N} промптах — одна й та сама людина на всіх кадрах.

2) НЕ КОПІЮВАТИ ОБЛИЧЧЯ З РЕФЕРЕНСІВ
— Ігноруй обличчя/голову реальної людини на референсі. Бери лише позу, композицію, положення рук, настрій. Заборонено копіювати риси обличчя, очі, ніс, губи, бороду, татуювання, родимки.`
    : `1) СУБ'ЄКТ — ТІЛЬКИ ТОВАР, БЕЗ МОДЕЛІ
— ${cat.subjectBlock}
— Жодної людини-моделі в кадрі (виняток — ракурс «у використанні», де допустима лише рука/частина людини). Фокус повністю на товарі на всіх ${N} кадрах.

2) ВИКОРИСТАННЯ РЕФЕРЕНСУ
— Бери з референсу лише сам товар: форму, колір, матеріал, деталі. Ігноруй усе зайве (руки, фон, інші предмети).`;

  const seasonRule = cat.seasonal
    ? `\n\n3) СЕЗОННІСТЬ
— Решта одягу моделі (окрім самого товару) відповідає сезону: зимовий → теплий одяг, без голого торсу; осінній → куртка/худі/светр/вітровка; літній → футболка/майка/шорти/топ; демісезон → світшот/лонгслів/легка куртка. Голий торс — лише якщо САМ товар цього вимагає (білизна, купальник, пляжний одяг).`
    : "";

  return `Ти — висококваліфікований арт-директор комерційної предметної та fashion-фотографії для карток товарів на маркетплейсах (Rozetka, Prom, Allegro, Amazon, Etsy). Створи ${num} (${N}) окремих фотореалістичних промптів — кожен описує ІНШИЙ ракурс ОДНОГО Й ТОГО САМОГО товару (категорія: ${cat.label}). Головна мета — каталогова якість: товар ТОЧНО як на референсі, чисто, продаюче.

ОБОВ'ЯЗКОВІ ПРАВИЛА:

${subjectRules}${seasonRule}

4) ОСВІТЛЕННЯ І КОЛІР (каталогова якість)
— М'яке, рівне, розсіяне студійне світло (softbox), без жорстких тіней, перепалених відблисків, кольорових кастів. Нейтральний баланс білого (~5500K), щоб колір і відтінок товару передавалися ТОЧНО як на референсі. Висока деталізація, реалістичні м'які тіні.

5) ФОН
${bgRule}
— У будь-якому режимі: жодного тексту, водяних знаків, логотипів площадок, сторонніх людей чи дублів товару на фоні.

6) ТОВАР — НАЙВИЩИЙ ПРІОРИТЕТ (точність 1:1 з референсом)
— Відтвори товар максимально точно: форма, силует/крій, пропорції, колір і відтінок, текстура, матеріал, шви, фурнітура, принти.
— Логотипи, бренд-написи й текст на товарі — РІВНО як на референсі: не спотворюй, не перемальовуй, не вигадуй, не дзеркаль. Деталь не видно — не домальовуй.
— НЕ «прикрашай» товар: не додавай елементів, яких немає на референсі. Не змінюй колір.

7) КАДРУВАННЯ І КОМПОЗИЦІЯ
— Вертикаль 3:4 (портрет для картки маркетплейсу). Товар повністю в кадрі (нічого важливого не обрізано), у фокусі, в центрі уваги. Камера на рівні, без екстремальних спотворень перспективи. Для «деталь/макро» — макро-чіткість.

8) ПРИГНІЧЕННЯ AI-АРТЕФАКТІВ
— Реалістична анатомія (для рук — п'ять пальців, без зрощень і деформацій), коректні пропорції. Уникай: спотворених/подвійних логотипів, «пливучого» нечитабельного тексту, дубльованого товару, асиметрії, пластикової/воскової шкіри, обрізаних кінцівок, водяних знаків.

9) РАКУРСИ (ВСЬОГО ${N}):
${angleList}

ФОРМАТ ВИВОДУ:
— Поверни рівно ${N} промптів послідовно. Кожен починається зі слова PROMPT:
${cat.onModel ? `— Одразу після PROMPT: встав ІДЕНТИЧНИЙ "character sheet" моделі (правило 1).\n` : ""}— Далі: конкретний ракурс, кадрування 3:4, фон згідно з режимом, освітлення, коротке нагадування про точність товару й анатомії.
— Жодних службових пояснень чи коментарів поза промптами.`;
}

const IMAGE_INSTRUCTIONS = `ВИКОРИСТАННЯ РЕФЕРЕНСУ:
— Додане фото використовуй ТІЛЬКИ для розуміння товару: силует, крій, колір і відтінок, текстуру, матеріал, шви, фурнітуру, принти, логотипи, посадку, положення рук.
— Повністю ігноруй обличчя, голову, волосся, очі, губи, бороду, родимки, татуювання та будь-які унікальні риси людини на референсі.

ТОВАР — НАЙВИЩИЙ ПРІОРИТЕТ (1:1 з референсом):
— Відтвори товар максимально точно: форма, крій, КОЛІР і ВІДТІНОК, текстура, матеріал, шви, фурнітура, принти.
— Логотипи, бренд-написи й текст на товарі — РІВНО як на референсі: не спотворюй, не перемальовуй, не вигадуй, не дзеркаль. Якщо деталь не видно — не домальовуй.
— НЕ додавай елементів, яких немає на референсі. НЕ змінюй колір товару.

МОДЕЛЬ:
— Тип і опис моделі задані в текстовому промпті вище. Зберігай ОДНУ Й ТУ Ж саму людину: те саме обличчя, риси, пропорції тіла, зріст, відтінок шкіри, колір і довжину волосся, бороду (якщо є). Заборонено змінювати зовнішність моделі між ракурсами.
— Статура природна (не бодібілдерська), щоб посадка товару відповідала реальному покупцеві.

ОСВІТЛЕННЯ І КОЛІР:
— М'яке рівне студійне світло (softbox), нейтральний баланс білого (~5500K), без жорстких тіней, перепалених відблисків і кольорових кастів. Колір товару — точно як на референсі.

ФОН (режим КАТАЛОГ за замовчуванням):
— Чистий, рівний, нейтральний фон (світло-сірий / м'який студійний seamless). БЕЗ сторонніх об'єктів, тексту, реквізиту, інших людей, водяних знаків. Дозволена м'яка тінь під моделлю. Фон не конкурує з товаром.

СЕЗОННІСТЬ:
— Одяг моделі відповідає сезону товару. Зимові: тільки теплий одяг, без голого торсу. Осінні: куртка/худі/светр/вітровка. Літні: футболка/майка/сорочка/топ. Демісезон: світшот/лонгслів/легка куртка. Голий торс — лише якщо сам товар цього вимагає.

КАДРУВАННЯ:
— Вертикаль 3:4. Товар повністю в кадрі, у фокусі, в центрі, не обрізаний. Камера на рівні, без спотворень перспективи.

ПРИГНІЧЕННЯ АРТЕФАКТІВ:
— Реалістична анатомія рук (п'ять пальців, без зрощень і деформацій), коректні пропорції тіла. Уникай: спотворених логотипів, нечитабельного «пливучого» тексту, подвійного/дубльованого товару, асиметричних очей, пластикової шкіри, обрізаних кінцівок, водяних знаків.

ЯКІСТЬ:
— Максимальна роздільність, чіткий фокус на товарі, фотореалістична деталізація. Вертикальне співвідношення сторін 3:4.

ЯКЩО ВИНИКАЄ ПОМИЛКА (Unable to show the generated image):
— Перегенеруй, не змінюючи модель, товар, колір і сезонність. Можна трохи змінити позу/фон.

У відповідь надавати тільки слово ГОТОВО.`;

export interface GeminiImagePart {
  inline_data: { mime_type: string; data: string };
}

export async function generatePrompts(
  apiKey: string | null,
  cat: Category,
  productType: string,
  season: string,
  gender: string,
  referenceImages: GeminiImagePart[],
  angles: AngleDef[]
): Promise<string[]> {
  const N = angles.length;
  const imageParts = referenceImages.map((img) => ({ inline_data: img.inline_data }));

  // Gender line only matters for on-model categories; season drives the
  // lifestyle-vs-catalog background mode.
  const genderLine = cat.onModel
    ? `Цільова аудиторія / Gender: ${gender || "обери доречний для товару"}\n`
    : "";

  const body = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(angles, season ? "lifestyle" : "catalog", cat) }],
    },
    contents: [
      {
        role: "user",
        parts: [
          ...imageParts,
          {
            text:
              `Категорія товару: ${cat.label}.\n` +
              `Товар визнач самостійно з доданого референс-фото (тип, колір, матеріал, деталі)` +
              (productType ? ` — підказка від користувача: ${productType}.` : ".") + `\n` +
              genderLine +
              (season
                ? `Сезон/сцена: ${season} — покажи товар у відповідній сезонній lifestyle-сцені (саме в цьому сезоні).\n`
                : `Сезон не задано — чистий нейтральний каталоговий фон.\n`) +
              `Створи ${N} детальних промптів згідно з правилами вище.`,
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
  referenceImages: GeminiImagePart[],
  modelOverride?: string,
  locationOverride?: string
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
  const model = modelOverride ?? (apiKey === null
    ? (await import("./vertex-auth")).VERTEX_IMAGE_MODEL
    : STUDIO_IMAGE_MODEL);

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
    res = await callGenerateContent(model, body, null, locationOverride);
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
