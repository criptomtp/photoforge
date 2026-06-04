// Client-safe — no DB/server imports. Product categories: each has its own angle
// set, on-model/gender/season flags, and a subject block injected into the prompt.
import type { AngleDef } from "./angles";

export type CategoryId = "clothing" | "shoes" | "jewelry" | "accessories" | "object";

export interface CategoryPreset {
  id: string;
  label: string;
  angles: readonly string[];
}

export interface Category {
  id: CategoryId;
  label: string;
  emoji: string;
  onModel: boolean;     // a human model is present
  needsGender: boolean; // gender selection matters for this category
  seasonal: boolean;    // seasonal clothing/scene logic applies
  angles: readonly AngleDef[];
  presets: readonly CategoryPreset[];
  // Category-specific "subject + framing" rules injected into the system prompt.
  subjectBlock: string;
}

const ids = (a: readonly AngleDef[]) => a.map((x) => x.id);
const presetsFor = (a: readonly AngleDef[]): CategoryPreset[] => [
  { id: "full", label: `Повний набір — ${a.length}`, angles: ids(a) },
  { id: "quick3", label: "Швидко — 3", angles: ids(a).slice(0, 3) },
  { id: "one", label: "Тільки 1-й", angles: [a[0].id] },
];

const CLOTHING_ANGLES: AngleDef[] = [
  { id: "fullbody_front", label: "Повний зріст спереду", desc: "Повний зріст спереду, товар добре видно." },
  { id: "fullbody_side", label: "Повний зріст збоку", desc: "Повний зріст збоку." },
  { id: "fullbody_back", label: "Повний зріст ззаду", desc: "Повний зріст ззаду — силует і посадка." },
  { id: "three_quarter_front", label: "3/4 спереду", desc: "Ракурс 3/4 спереду, ключові деталі." },
  { id: "three_quarter_back", label: "3/4 ззаду", desc: "Ракурс 3/4 ззаду — спинка, шви, посадка." },
  { id: "closeup", label: "Деталь", desc: "Великий план деталі (текстура, шви, логотип)." },
  { id: "action", label: "В русі", desc: "Середній план у русі/дії." },
  { id: "creative", label: "Креатив", desc: "Креативний, але реалістичний кадр." },
];

const SHOES_ANGLES: AngleDef[] = [
  { id: "pair_front", label: "Пара спереду", desc: "Пара взуття спереду, рівно, чистий фон." },
  { id: "pair_side", label: "Профіль", desc: "Один черевик строго збоку (профіль) — силует." },
  { id: "pair_back", label: "Ззаду", desc: "Вид ззаду — пятка, задник." },
  { id: "top_down", label: "Зверху", desc: "Вид зверху на пару." },
  { id: "sole", label: "Підошва", desc: "Підошва / протектор." },
  { id: "on_foot", label: "На нозі", desc: "Взуття на нозі моделі, природна поза." },
  { id: "closeup", label: "Деталь", desc: "Макро: матеріал, шви, фурнітура, логотип." },
  { id: "lifestyle", label: "Lifestyle", desc: "На нозі в русі / у сцені." },
];

const JEWELRY_ANGLES: AngleDef[] = [
  { id: "on_model", label: "На моделі", desc: "Прикраса на відповідній частині тіла (рука/шия/вухо), крупно." },
  { id: "macro", label: "Макро", desc: "Макро-деталь: камені, метал, фактура." },
  { id: "product_white", label: "На фоні", desc: "Прикраса на чистому фоні/підставці." },
  { id: "side", label: "Збоку", desc: "Збоку — об'єм і профіль виробу." },
  { id: "clasp", label: "Застібка", desc: "Деталь застібки/кріплення." },
  { id: "lifestyle", label: "В образі", desc: "Прикраса у стильному образі моделі." },
  { id: "top_down", label: "Зверху", desc: "Вид зверху на чистому фоні." },
  { id: "angle34", label: "3/4", desc: "Ракурс 3/4 — об'єм виробу." },
];

const ACCESSORIES_ANGLES: AngleDef[] = [
  { id: "on_hand", label: "В руках", desc: "Аксесуар у руках моделі." },
  { id: "on_shoulder", label: "На тілі", desc: "Носіння на плечі/тілі моделі." },
  { id: "front", label: "Спереду", desc: "Продуктово спереду, чистий фон." },
  { id: "back", label: "Ззаду", desc: "Вид ззаду." },
  { id: "inside", label: "Всередині", desc: "Відкритий/внутрішня частина, відділення." },
  { id: "closeup", label: "Деталь", desc: "Фурнітура, матеріал, логотип крупно." },
  { id: "product_white", label: "На фоні", desc: "На чистому фоні без моделі." },
  { id: "lifestyle", label: "Lifestyle", desc: "В образі / у сцені." },
];

const OBJECT_ANGLES: AngleDef[] = [
  { id: "front", label: "Спереду", desc: "Товар спереду на чистому фоні, рівно." },
  { id: "side", label: "Збоку", desc: "Вид збоку." },
  { id: "back", label: "Ззаду", desc: "Вид ззаду." },
  { id: "angle34", label: "3/4", desc: "Ракурс 3/4 — об'єм." },
  { id: "top_down", label: "Зверху", desc: "Вид зверху." },
  { id: "closeup", label: "Деталь", desc: "Макро важливої деталі/текстури." },
  { id: "in_scene", label: "В сцені", desc: "Товар у реалістичній сцені/інтер'єрі." },
  { id: "in_use", label: "У використанні", desc: "Товар у застосуванні (за потреби — рука/частина людини)." },
];

export const CATEGORIES: Record<CategoryId, Category> = {
  clothing: {
    id: "clothing", label: "Одяг", emoji: "👕", onModel: true, needsGender: true, seasonal: true,
    angles: CLOTHING_ANGLES, presets: presetsFor(CLOTHING_ANGLES),
    subjectBlock: "СУБ'ЄКТ: жива модель-людина, ОДЯГНЕНА в товар. Тип моделі — за статтю (правило статі). Модель звичайної статури, нейтральне обличчя, акцент на товарі. Решта одягу моделі відповідає сезону.",
  },
  shoes: {
    id: "shoes", label: "Взуття", emoji: "👟", onModel: true, needsGender: true, seasonal: false,
    angles: SHOES_ANGLES, presets: presetsFor(SHOES_ANGLES),
    subjectBlock: "СУБ'ЄКТ: взуття. Продуктові ракурси — пара на чистому фоні, рівно, без людини. Ракурси «на нозі/lifestyle» — взуття на нозі/ногах моделі (за статтю), природна поза, акцент на взутті. Колір, матеріал, фурнітура, підошва — точно як на референсі.",
  },
  jewelry: {
    id: "jewelry", label: "Прикраси", emoji: "💍", onModel: true, needsGender: false, seasonal: false,
    angles: JEWELRY_ANGLES, presets: presetsFor(JEWELRY_ANGLES),
    subjectBlock: "СУБ'ЄКТ: ювелірний виріб. Визнач тип: каблучка→на пальці/руці, кольє/підвіска→на шиї/декольте, сережки→на вусі, браслет→на зап'ясті. «На моделі» — крупно показуй прикрасу на відповідній частині тіла доглянутої моделі. Продуктові — на чистому фоні/підставці, макро-чіткість каменів і металу. Точно відтвори метал, камені, форму.",
  },
  accessories: {
    id: "accessories", label: "Аксесуари", emoji: "👜", onModel: true, needsGender: false, seasonal: false,
    angles: ACCESSORIES_ANGLES, presets: presetsFor(ACCESSORIES_ANGLES),
    subjectBlock: "СУБ'ЄКТ: аксесуар (сумка, рюкзак, ремінь, шапка, окуляри тощо). «На моделі» — модель природно тримає/носить аксесуар. Продуктові — на чистому фоні, видно форму, фурнітуру, матеріал. Точно відтвори колір, матеріал, фурнітуру, логотипи.",
  },
  object: {
    id: "object", label: "Не-носимий товар", emoji: "📦", onModel: false, needsGender: false, seasonal: false,
    angles: OBJECT_ANGLES, presets: presetsFor(OBJECT_ANGLES),
    subjectBlock: "СУБ'ЄКТ: предметний товар (дім, гаджети, кухня, косметика тощо) БЕЗ людини-моделі. Фотографуй сам товар професійно: чистий каталоговий фон для продуктових ракурсів, реалістична сцена/інтер'єр для lifestyle. Для «у використанні» допустима рука/частина людини, без повноцінної моделі. Точно відтвори форму, колір, матеріал, написи, логотипи.",
  },
};

export const CATEGORY_LIST = Object.values(CATEGORIES);

export function category(id?: string): Category {
  return CATEGORIES[(id as CategoryId)] ?? CATEGORIES.clothing;
}
