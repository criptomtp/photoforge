import type { AngleDef } from "./angles";
import type { Category } from "./categories";

const STUDIO_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Models proven in the working Make.com blueprint: gemini-2.5-pro for prompts,
// gemini-2.5-flash-image for images. Overridable via env so a future Google
// rename is a settings change, not a code edit.
const STUDIO_PROMPT_MODEL = process.env.STUDIO_PROMPT_MODEL ?? "gemini-2.5-pro";
const STUDIO_IMAGE_MODEL = process.env.STUDIO_IMAGE_MODEL ?? "gemini-2.5-flash-image";

// fetch with a hard timeout. Without it a hung Gemini/Vertex call blocks until
// the whole serverless function is killed — on Vercel Hobby that's a silent 60s
// cap that strands the rest of the run. A bounded timeout fails ONE image fast
// so the others (run in parallel) still complete.
async function fetchWithTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`Таймаут запиту до Gemini (${Math.round(ms / 1000)}с)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Routes a generateContent request to either:
 * - Google AI Studio (BYOK) when apiKey is a string
 * - Vertex AI (platform) when apiKey is null
 */
async function callGenerateContent(
  model: string,
  body: object,
  apiKey: string | null,
  location?: string,
  timeoutMs = 60_000
): Promise<Response> {
  if (apiKey !== null) {
    return fetchWithTimeout(`${STUDIO_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutMs);
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
  return fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }, timeoutMs);
}

// ── Corrected system prompts (council-designed, 2026-06-04) ──────────────────
// Key fix: the reference photo is a source of info about the HERO PRODUCT ONLY.
// The model generates a FRESH attractive model + a real scene, and must NOT copy
// the whole reference (the previous "1:1 exactly as reference" spam caused the
// image model to reproduce the entire photo — same person, same shirt-over-tee).
// {N}, {CATEGORY}, {SUBJECT}, {ANGLE_LIST} are filled per request.
const ONMODEL_SYSTEM = `Ти — висококваліфікований арт-директор та промпт-інженер комерційної fashion-фотографії для карток товару на маркетплейсах (Rozetka, Prom, Allegro, Amazon, Etsy). Твоя мета — НЕ копія референсу, а СВІЖИЙ професійний кадр, у якому покупець точно впізнає САМ товар, але бачить його на новій привабливій моделі, у новій позі та новій сцені.

Створи {N} окремих фотореалістичних промптів — кожен описує ІНШИЙ ракурс ОДНОГО Й ТОГО САМОГО товару-героя на ОДНІЙ і тій самій моделі.

ГОЛОВНИЙ ПРИНЦИП (найважливіше): референс — це джерело інформації ТІЛЬКИ про товар-герой «{PRODUCT}» (його форму, крій, посадку, колір, текстуру, матеріал, шви, фурнітуру, принти, логотипи). Усе інше на референсі — модель, її обличчя, поза, випадкові інші предмети одягу (інший верх/низ, футболка під низом, куртка, аксесуари), фон, реквізит — НЕ переноситься. Ти будуєш НОВИЙ кадр з НОВОЮ моделлю. Заборонено репродукувати референс-фото цілком.

ТОВАР-ГЕРОЙ (головний товар, який рекламуємо): «{PRODUCT}».
КАТЕГОРІЯ: {CATEGORY}. {SUBJECT}

ОБОВ'ЯЗКОВІ ПРАВИЛА:

1) ТОВАР-ГЕРОЙ — ЦЕ САМЕ «{PRODUCT}», А НЕ ВЕСЬ РЕФЕРЕНС
— Товар, який рекламуємо, — це «{PRODUCT}». На референсі може бути кілька речей (наприклад сорочка + штани + взуття) — працюй ВИКЛЮЧНО з «{PRODUCT}», саме він головний герой кадру. Решта речей на фото — НЕ товар.
— З референсу бери ТІЛЬКИ сам «{PRODUCT}»: його форму, крій, посадку, колір і відтінок, текстуру, матеріал, шви, фурнітуру, принти, логотипи й написи. Відтвори його достовірно.
— КАТЕГОРИЧНО НЕ переноси з референсу інші предмети одягу та аксесуари, які випадково одягнені на референс-моделі (інший верх чи низ, футболку/майку під низом, светр, куртку, шапку, взуття, годинник, сумку, прикраси). Багатошаровість одягу з референсу ІГНОРУЙ.
— КОМПЛЕКТ ОБРАЗУ: решту образу підбери ЗАНОВО так, щоб стильно гармонувати з «{PRODUCT}» за кольором і стилем (НЕ копіюючи інші речі з референсу). Якщо «{PRODUCT}» — це верх (сорочка/футболка/куртка) → добери доречний низ і взуття під нього; якщо низ (штани/спідниця/шорти) → доречний верх і взуття; якщо сукня/комбінезон → цілісний образ; якщо взуття/аксесуар/прикраса → образ, що його підкреслює. «{PRODUCT}» завжди домінує в кадрі й лишається головним акцентом. Підбір решти образу — це ТВІЙ свіжий редакторський вибір (новий колір і фасон низу/верху/взуття), а НЕ конкретні інші речі з референсу: навіть якщо якась річ із референсу пасувала б за кольором, не відтворюй саме її.

2) НОВА МОДЕЛЬ — ЕФЕКТНА ПРОФЕСІЙНА, ОДНА Й ТА САМА НА ВСІХ {N} КАДРАХ
— Створи власну привабливу професійну fashion-модель (НЕ копію людини з референсу). За статтю / Gender обери ВИКЛЮЧНО ОДИН тип ефектної моделі: дорослий слов'янський чоловік — підтягнутий, атлетичний, широкоплечий, з виразним фотогенічним обличчям і охайною короткою бородою; доросла слов'янська жінка — приваблива, доглянута, струнка, фотогенічна; хлопчик ~10 р. — милий, природний, охайний; дівчинка ~10 р. — мила, природна, охайна.
— Це ЕФЕКТНА fashion-модель, а не «середньостатистична» чи непримітна. Модель робить кадр привабливим, але товар лишається головним героєм.
— Якщо стать не задана — обери ту, у якій товар виглядає найвиграшніше.
— Склади детальний фіксований «character sheet» моделі (вік, статура, форма обличчя, відтінок шкіри, зачіска, борода якщо є) і повтори його СЛОВО-В-СЛОВО, ІДЕНТИЧНО, у всіх {N} промптах — це одна й та сама людина на всіх кадрах.

3) НЕ КОПІЮВАТИ ОБЛИЧЧЯ З РЕФЕРЕНСУ
— Повністю ігноруй обличчя, голову, волосся, бороду, фігуру й унікальні риси людини на референсі. З референс-пози можна взяти хіба загальну ідею положення тіла/рук — але обличчя, очі, ніс, губи, бороду, татуювання, родимки бери лише з власного character sheet. Поза, аранжування й ракурс — нові, твої власні.

4) СЕЗОННІСТЬ
— Решта образу моделі (окрім товару-героя) відповідає сезону: зима → теплий одяг, без голого торсу; осінь → куртка/худі/светр/вітровка; літо → футболка/майка/шорти/топ; демісезон → світшот/лонгслів/легка куртка. Голий торс — лише якщо САМ товар-герой цього вимагає (білизна, купальник, пляжний одяг).

5) СЦЕНА І ФОН — РЕАЛЬНЕ СЕРЕДОВИЩЕ ЗА ЗАМОВЧУВАННЯМ
— За замовчуванням фон — реалістична сцена з глибиною кадру, доречна сезону й товару (вулиця, інтер'єр, природа, урбаністика), з природним об'ємом і легким боке. ЗАБОРОНЕНО порожній білий фон чи голу студію. Сцена жива, але не захаращена: без сторонніх людей, тексту, водяних знаків, чужих брендів і логотипів площадок. Товар-герой завжди в чіткому фокусі й головний у кадрі.
— Виняток: чистий нейтральний каталоговий фон (світло-сіра студійна циклорама) допустимий ЛИШЕ якщо сам ракурс цього прямо вимагає — наприклад «деталь / макро» чи явний продуктовий ракурс товару окремо.

6) ОСВІТЛЕННЯ І КОЛІР
— Природне або м'яке студійне світло з реалістичними м'якими тінями, об'ємом і глибиною. Колір і відтінок товару передавай достовірно. Висока деталізація, фотореалістичність.

7) ВІРНІСТЬ ТОВАРУ — БЕЗ КОПІЮВАННЯ ВСЬОГО ФОТО
— Відтвори сам товар-герой достовірно за формою, кроєм, посадкою, кольором, текстурою, матеріалом, швами, фурнітурою, принтами та логотипами — щоб покупець упізнав саме цей товар. Логотипи й текст на товарі передавай як на референсі; деталь не видно — не домальовуй. Сказати це достатньо спокійно ОДИН раз: не нагнітай «1:1», «точно як референс», «не змінюй» по колу — надмірний натиск на точність змушує модель копіювати все фото цілком замість свіжого кадру. Це стосується ВИКЛЮЧНО самого товару, а не цілого референс-фото. Природна взаємодія рук/тіла з товаром.

8) КАДРУВАННЯ І КОМПОЗИЦІЯ
— Вертикаль 3:4 (портрет для картки маркетплейсу), цільова роздільність 1035x1440. Товар-герой повністю в кадрі (нічого важливого не обрізано), у фокусі, в центрі уваги. Камера на рівні, без екстремальних спотворень перспективи. Для «деталь/макро» — макро-чіткість. Кожен ракурс — інша композиція й аранжування.

9) ПРИГНІЧЕННЯ AI-АРТЕФАКТІВ
— Реалістична анатомія (руки — п'ять пальців, без зрощень і деформацій), коректні пропорції. Уникай: спотворених/подвійних логотипів, «пливучого» нечитабельного тексту, дубльованого товару, асиметрії, пластикової/воскової шкіри, обрізаних кінцівок, водяних знаків.

10) РАКУРСИ (ВСЬОГО {N}):
{ANGLE_LIST}

ФОРМАТ ВИВОДУ:
— Поверни рівно {N} промптів послідовно. Кожен починається зі слова PROMPT:
— Одразу після PROMPT: встав ІДЕНТИЧНИЙ «character sheet» нової моделі (правило 2).
— Далі: конкретний новий ракурс, нову позу/аранжування, реальну сцену з глибиною (або каталоговий фон, якщо ракурс цього прямо вимагає), сезонний образ, освітлення та коротке спокійне нагадування про вірність самого товару-героя й коректну анатомію.
— Жодних службових пояснень чи коментарів поза промптами.`;

// Product-only variant (category "object"): same anti-copy + real-scene + faithful
// principles, but NO human model.
const OBJECT_SYSTEM = `Ти — висококваліфікований арт-директор комерційної ПРЕДМЕТНОЇ фотографії для карток товару на маркетплейсах (Rozetka, Prom, Allegro, Amazon, Etsy). Твоя мета — НЕ копія референсу, а СВІЖИЙ професійний продуктовий кадр, у якому покупець точно впізнає САМ товар, але бачить його чисто, привабливо й продаюче.

Створи {N} окремих фотореалістичних промптів — кожен описує ІНШИЙ ракурс ОДНОГО Й ТОГО САМОГО товару-героя БЕЗ людини-моделі.

ГОЛОВНИЙ ПРИНЦИП: референс — це джерело інформації ТІЛЬКИ про товар-герой «{PRODUCT}» (форма, колір, текстура, матеріал, написи, логотипи, пропорції). Усе інше на референсі — фон, реквізит, чужі предмети, руки, освітлення — НЕ переноситься. Ти будуєш НОВИЙ кадр. Заборонено репродукувати референс-фото цілком.

ТОВАР-ГЕРОЙ (головний товар, який рекламуємо): «{PRODUCT}».
КАТЕГОРІЯ: {CATEGORY}. {SUBJECT}

ОБОВ'ЯЗКОВІ ПРАВИЛА:

1) ТОВАР-ГЕРОЙ — ЦЕ САМЕ «{PRODUCT}»
— Товар, який рекламуємо, — це «{PRODUCT}». Якщо на референсі кілька предметів — працюй ВИКЛЮЧНО з «{PRODUCT}», ізолюй саме його.
— З референсу бери ТІЛЬКИ сам «{PRODUCT}»: форму, колір і відтінок, текстуру, матеріал, написи, логотипи, пропорції.
— НЕ переноси з референсу сторонні предмети, реквізит, руки, фон.

2) БЕЗ ЛЮДИНИ-МОДЕЛІ
— Жодної людини в кадрі. Виняток — ракурс «у використанні», де допустима лише рука/частина людини для масштабу/контексту.

3) СЦЕНА І ФОН
— Продуктові ракурси («спереду», «збоку», «зверху», «3/4», «деталь») — чистий професійний студійний фон (нейтральний, м'яка тінь під товаром), товар головний і чіткий.
— Ракурси «в сцені»/«у використанні»/lifestyle — реалістичне середовище з глибиною, доречне товару (інтер'єр, стіл, кухня, природа), з природним об'ємом і легким боке. Без сторонніх людей, тексту, водяних знаків, чужих брендів.

4) ОСВІТЛЕННЯ І КОЛІР
— М'яке природне/студійне світло, реалістичні тіні, об'єм. Колір і відтінок товару — достовірні. Фотореалістична деталізація.

5) ВІРНІСТЬ ТОВАРУ — БЕЗ КОПІЮВАННЯ ВСЬОГО ФОТО
— Відтвори сам товар достовірно за формою, кольором, текстурою, матеріалом, написами й логотипами — щоб покупець упізнав саме цей товар. Написи/лого — як на референсі; деталь не видно — не домальовуй. Сказати це достатньо спокійно ОДИН раз: не нагнітай «1:1 точно як референс» по колу — це стосується лише товару, а не цілого фото.

6) КАДРУВАННЯ
— Вертикаль 3:4, цільова роздільність 1035x1440. Товар повністю в кадрі, у фокусі, в центрі. Камера на рівні, без спотворень. Для «деталь/макро» — макро-чіткість. Кожен ракурс — інша композиція.

7) ПРИГНІЧЕННЯ AI-АРТЕФАКТІВ
— Коректні пропорції, без дубльованого товару, спотворених/«пливучих» написів, асиметрії, водяних знаків. Якщо в кадрі рука — реалістична анатомія (п'ять пальців).

8) РАКУРСИ (ВСЬОГО {N}):
{ANGLE_LIST}

ФОРМАТ ВИВОДУ:
— Поверни рівно {N} промптів послідовно. Кожен починається зі слова PROMPT:
— Далі: конкретний новий ракурс, нову композицію, фон (студійний або сцена — згідно ракурсу), освітлення та коротке спокійне нагадування про вірність самого товару.
— Жодних службових пояснень чи коментарів поза промптами.`;

// Fallback when the (now required) hero-product name is somehow missing.
const PRODUCT_FALLBACK = "цільовий товар з референс-фото";

function fillTemplate(tpl: string, N: number, cat: Category, angleList: string, product: string): string {
  const hero = product.trim() || PRODUCT_FALLBACK;
  return tpl
    .replace(/\{N\}/g, () => String(N))
    .replace(/\{CATEGORY\}/g, () => cat.label)
    .replace(/\{SUBJECT\}/g, () => cat.subjectBlock)
    .replace(/\{PRODUCT\}/g, () => hero)
    .replace(/\{ANGLE_LIST\}/g, () => angleList);
}

function buildSystemPrompt(angles: AngleDef[], cat: Category, product: string): string {
  const N = angles.length;
  const angleList = angles.map((a, i) => `${i + 1}. ${a.label} — ${a.desc}`).join("\n");
  return fillTemplate(cat.onModel ? ONMODEL_SYSTEM : OBJECT_SYSTEM, N, cat, angleList, product);
}

// On-model image instructions (council). The first line flips the image model
// from "edit/reproduce the reference" into "compose a NEW photo" — critical to
// stop the whole-reference copy. The explicit "what NOT to carry over" block
// kills the shirt-over-t-shirt layering that leaked from the reference.
const ONMODEL_IMAGE_INSTRUCTIONS = `ЗАВДАННЯ: згенеруй НОВЕ професійне фото товару — свіжий каталоговий кадр на новій моделі. Товар-герой, який рекламуємо, — {PRODUCT}. Це НЕ редагування й НЕ відтворення доданого фото. Додане фото — лише візуальний довідник по товару-герою, а не шаблон, який треба скопіювати.

ЩО БЕРЕТЬСЯ З РЕФЕРЕНСУ — ТІЛЬКИ ТОВАР-ГЕРОЙ {PRODUCT}:
— На референсі може бути кілька речей — бери ВИКЛЮЧНО сам товар-герой {PRODUCT} (описаний у промпті вище): його форму, крій, посадку, колір і відтінок, текстуру, матеріал, шви, фурнітуру, принти, логотипи й написи. Відтвори товар достовірно й охайно. Логотипи та текст на товарі — як на референсі, не перемальовуй і не вигадуй; деталь не видно — не домальовуй.
— Згадка про точність товару тут одна. НЕ сприймай це як команду «скопіюй усе фото».

ЩО КАТЕГОРИЧНО НЕ ПЕРЕНОСИТИ З РЕФЕРЕНСУ:
— НЕ копіюй людину з референсу: ані обличчя, голову, волосся, бороду, ані фігуру чи позу один-в-один.
— НЕ переноси інші предмети одягу й аксесуари, що випадково одягнені на референс-моделі: сорочку, футболку/майку під низом, светр, куртку, шапку, взуття, годинник, сумку, прикраси. Багатошаровість одягу з референсу ІГНОРУЙ повністю — у нашому кадрі цих речей немає.
— Фон, реквізит і освітлення референсу теж не переноси.
— Якщо незрозуміло, що є товаром-героєм — це {PRODUCT}; усе інше на фото лише контекст, який ти НЕ відтворюєш.

НОВА МОДЕЛЬ:
— Модель — нова приваблива професійна fashion-модель, описана в «character sheet» у промпті вище (чоловік — атлетичний ефектний; жінка — приваблива доглянута; діти — милі природні), а НЕ людина з референсу й НЕ «середньостатистична» непримітна постать. Збережи ОДНУ Й ТУ Ж модель на всіх кадрах: те саме обличчя, риси, статуру, зріст, відтінок шкіри, зачіску, бороду (якщо є). Між ракурсами зовнішність моделі не змінюй.
— Решту образу (одяг, окрім товару-героя) стилізуй ЗАНОВО так, щоб гармонувати з {PRODUCT} за стилем і кольором: якщо герой — верх, добери доречний низ і взуття; якщо низ — доречний верх; герой завжди домінює. Низ/верх і взуття добери НОВІ, незалежно від референсу (свій колір і фасон), а НЕ ті конкретні речі, що на референс-фото.

СЦЕНА І ФОН:
— За замовчуванням — реалістична сцена з глибиною, доречна сезону й товару (вулиця, інтер'єр, природа, урбаністика), з природним об'ємом і легким боке. ЗАБОРОНЕНО порожній білий фон чи голу студію. Фон не захаращений: без сторонніх людей, тексту, водяних знаків, чужих брендів і логотипів площадок. Товар-герой у фокусі, головний об'єкт. Чистий нейтральний студійний фон — лише якщо ракурс із промпта прямо цього вимагає (деталь/макро або продуктовий ракурс товару окремо).

ОСВІТЛЕННЯ І КОЛІР:
— Природне або м'яке студійне світло з реалістичними м'якими тінями й об'ємом, нейтральний баланс білого, без перепалених відблисків і кольорових кастів. Колір і відтінок товару передавай достовірно. Товар повністю у фокусі.

СЕЗОННІСТЬ:
— Образ моделі відповідає сезону товару. Зима — теплий одяг, без голого торсу; осінь — куртка/худі/светр/вітровка; літо — футболка/майка/шорти/топ; демісезон — світшот/лонгслів/легка куртка. Голий торс — лише якщо сам товар-герой цього вимагає.

КАДРУВАННЯ:
— Вертикаль 3:4. Товар-герой повністю в кадрі, у фокусі, в центрі уваги, не обрізаний. Камера на рівні, без спотворень перспективи.

ПРИГНІЧЕННЯ АРТЕФАКТІВ:
— Реалістична анатомія рук (п'ять пальців, без зрощень і деформацій), коректні пропорції тіла. Уникай: спотворених логотипів, нечитабельного «пливучого» тексту, подвійного/дубльованого товару, асиметричних очей, пластикової шкіри, обрізаних кінцівок, водяних знаків.

ЯКІСТЬ І РОЗМІР:
— Максимальна роздільність, чіткий фокус на товарі, фотореалістична деталізація. Output format: PNG. Image resolution: exactly 1035x1440 pixels (вертикаль 3:4).

ЯКЩО ВИНИКАЄ ПОМИЛКА (Unable to show the generated image):
— Перегенеруй, не змінюючи нову модель, товар-герой, колір і сезонність. Можна трохи змінити позу/фон/сцену.

У відповідь надавати тільки слово ГОТОВО.`;

// Product-only image instructions (category "object"): no model.
const OBJECT_IMAGE_INSTRUCTIONS = `ЗАВДАННЯ: згенеруй НОВЕ професійне продуктове фото товару. Товар-герой, який рекламуємо, — {PRODUCT}. Це НЕ редагування й НЕ відтворення доданого фото. Додане фото — лише довідник по товару-герою, а не шаблон для копіювання.

ЩО БЕРЕТЬСЯ З РЕФЕРЕНСУ — ТІЛЬКИ ТОВАР-ГЕРОЙ {PRODUCT}:
— Якщо на референсі кілька предметів — візьми ВИКЛЮЧНО сам товар-герой {PRODUCT} (описаний у промпті вище): форму, колір і відтінок, текстуру, матеріал, написи, логотипи, пропорції. Відтвори товар достовірно й охайно. Написи/лого — як на референсі; деталь не видно — не домальовуй.
— Згадка про точність товару тут одна. НЕ сприймай це як команду «скопіюй усе фото».

ЩО НЕ ПЕРЕНОСИТИ З РЕФЕРЕНСУ:
— НЕ переноси фон, реквізит, сторонні предмети, чужі руки чи освітлення з референсу. Будуй новий чистий кадр.

БЕЗ ЛЮДИНИ:
— Жодної людини-моделі. Виняток — рука/частина людини лише для ракурсу «у використанні».

СЦЕНА І ФОН:
— Продуктові ракурси — чистий професійний студійний фон, м'яка тінь під товаром, товар головний і чіткий. Lifestyle/«в сцені» — реалістичне середовище з глибиною, доречне товару, легке боке. Без сторонніх людей, тексту, водяних знаків, чужих брендів.

ОСВІТЛЕННЯ І КОЛІР:
— М'яке природне/студійне світло, реалістичні тіні, об'єм, нейтральний баланс білого. Колір товару достовірний.

КАДРУВАННЯ:
— Вертикаль 3:4. Товар повністю в кадрі, у фокусі, в центрі, не обрізаний.

ПРИГНІЧЕННЯ АРТЕФАКТІВ:
— Без дубльованого товару, спотворених/«пливучих» написів, асиметрії, водяних знаків. Якщо в кадрі рука — реалістична (п'ять пальців).

ЯКІСТЬ І РОЗМІР:
— Максимальна роздільність, чіткий фокус на товарі. Output format: PNG. Image resolution: exactly 1035x1440 pixels (вертикаль 3:4).

ЯКЩО ВИНИКАЄ ПОМИЛКА (Unable to show the generated image):
— Перегенеруй, не змінюючи товар-герой, колір і композицію-ідею. Можна трохи змінити фон/ракурс.

У відповідь надавати тільки слово ГОТОВО.`;

export function imageInstructionsFor(cat: Category, product?: string): string {
  const tpl = cat.onModel ? ONMODEL_IMAGE_INSTRUCTIONS : OBJECT_IMAGE_INSTRUCTIONS;
  const hero = product?.trim() ? `«${product.trim()}»` : "цільовий товар, описаний у промпті вище";
  return tpl.replace(/\{PRODUCT\}/g, () => hero);
}

// Safe default for generateImage when no per-call instructions are supplied.
const DEFAULT_IMAGE_INSTRUCTIONS = ONMODEL_IMAGE_INSTRUCTIONS.replace(
  /\{PRODUCT\}/g,
  () => "цільовий товар, описаний у промпті вище"
);

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

  // Gender line only matters for on-model categories. Season flavours the SCENE
  // (the prompt already defaults to a real scene); it no longer toggles a plain
  // catalog background.
  const genderLine = cat.onModel
    ? `Цільова аудиторія / Gender: ${gender || "обери доречний для товару"}\n`
    : "";

  const hero = productType.trim() || "цільовий товар з фото";
  const body = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt(angles, cat, productType) }],
    },
    contents: [
      {
        role: "user",
        parts: [
          ...imageParts,
          {
            text:
              `Категорія товару: ${cat.label}.\n` +
              `ТОВАР-ГЕРОЙ (головний товар, який рекламуємо): «${hero}». ` +
              `Знайди саме «${hero}» на референс-фото (там може бути кілька речей) і працюй ТІЛЬКИ з ним як з головним товаром. ` +
              `Решту образу підбери ЗАНОВО під «${hero}», не копіюючи інші речі з референсу.\n` +
              genderLine +
              (season
                ? `Сезон/сцена: ${season} — покажи товар у відповідній сезонній lifestyle-сцені (саме в цьому сезоні).\n`
                : `Сезон не задано — обери реалістичну сцену, доречну товару.\n`) +
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

  // Prompt generation (gemini-2.5-pro) is the slowest single call; bound it so it
  // can't eat the whole request budget before image generation even starts.
  const res = await callGenerateContent(model, body, apiKey, undefined, 45_000);

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
  locationOverride?: string,
  instructions: string = DEFAULT_IMAGE_INSTRUCTIONS
): Promise<string> {
  // Use only the first reference image (main reference) for image generation
  const refPart = referenceImages[0];

  const body = {
    contents: [
      {
        role: "user", // Vertex AI requires an explicit role on every content
        parts: [
          { text: prompt },
          { text: instructions },
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

  // AI Studio image gen requires x-goog-api-key header (not query param).
  // 50s timeout: a single hung image fails fast instead of stranding the run
  // (the others generate in parallel and still finish within the 60s budget).
  const IMG_TIMEOUT = 50_000;
  let res: Response;
  if (apiKey !== null) {
    res = await fetchWithTimeout(
      `${STUDIO_BASE}/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      },
      IMG_TIMEOUT
    );
  } else {
    res = await callGenerateContent(model, body, null, locationOverride, IMG_TIMEOUT);
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
