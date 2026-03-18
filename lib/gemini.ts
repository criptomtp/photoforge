const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const SYSTEM_PROMPT = `Ти — висококваліфікований експерт-стиліст та промпт-інженер для комерційної ШІ-генерації фото (подібно до NanoBanana/Imagen). Твоє завдання — створити ВІСІМ (8) окремих фотореалістичних промптів, кожен з яких описує інший ракурс одного й того самого товару, використовуючи референси та текстовий опис.

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

6) РАКУРСИ (ВСЬОГО 8):
1. Full-body front view — повний зріст спереду, товар добре видно.
2. Full-body side view — повний зріст збоку.
3. Full-body back view — повний зріст ззаду, видно силует і посадку товару.
4. 3/4 front view — ракурс 3/4 спереду, акцент на ключових деталях.
5. 3/4 back view — ракурс 3/4 ззаду, акцент на спинці, швах і посадці.
6. Close-up detail shot — великий план важливої деталі (текстура, шви, логотип, фурнітура).
7. Medium action shot — середній план в русі / дії.
8. Creative realistic shot — креативний, але реалістичний кадр.

ФОРМАТ ВИВОДУ:
— Поверни рівно 8 промптів послідовно.
— Кожен промпт повинен починатися зі слова PROMPT:
— Одразу після PROMPT: вставляєш однаковий опис обраної моделі згідно правил вище.
— Потім додаєш детальний опис конкретного ракурсу, фону, сезонного одягу та сцени.
— Не додавай інших службових пояснень чи коментарів.`;

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
  apiKey: string,
  brand: string,
  productType: string,
  season: string,
  gender: string,
  referenceImages: GeminiImagePart[]
): Promise<string[]> {
  const imageParts = referenceImages.map((img) => ({ inline_data: img.inline_data }));

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: "user",
        parts: [
          ...imageParts,
          {
            text: `Опис товару: Бренд: ${brand}\nВид: ${productType}\nСезонність: ${season}\nGender / цільова аудиторія: ${gender}\nСтвори 8 детальних промптів згідно з правилами вище.`,
          },
        ],
      },
    ],
  };

  const res = await fetch(
    `${GEMINI_BASE}/gemini-2.5-pro:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini Pro error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  // Split on PROMPT: delimiter, filter empty entries
  const prompts = text
    .split(/PROMPT:/i)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 50);

  if (prompts.length < 8) {
    throw new Error(`Expected 8 prompts, got ${prompts.length}`);
  }

  return prompts.slice(0, 8);
}

export async function generateImage(
  apiKey: string,
  prompt: string,
  referenceImages: GeminiImagePart[]
): Promise<string> {
  // Use only the first reference image (main reference) for image generation
  const refPart = referenceImages[0];

  const body = {
    contents: [
      {
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

  const res = await fetch(
    `${GEMINI_BASE}/gemini-2.5-flash-preview-05-20:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini Flash error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  // Find the image part
  const imgPart = parts.find(
    (p: { inline_data?: { mime_type: string; data: string } }) =>
      p.inline_data?.mime_type?.startsWith("image/")
  );

  if (!imgPart?.inline_data?.data) {
    throw new Error("No image in Gemini response");
  }

  return imgPart.inline_data.data; // base64 string
}
