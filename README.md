# PhotoForge

AI-генерація професійних фото товарів для e-commerce. SaaS на Next.js 16 з SSE-стрімінгом, Supabase auth/storage, Stripe-білінгом і Google Gemini 2.5 (з fallback на Vertex AI).

- **Production:** https://photoforge-zeta.vercel.app
- **Supabase project:** `xciplfxgeqjahdxwkxbt`

## Stack

| Слой | Технологія |
|---|---|
| Framework | Next.js 16.2.0 (App Router, Turbopack) |
| UI | React 19.2, Tailwind CSS v4, Playfair Display + DM Sans |
| Auth/DB/Storage | Supabase (`@supabase/ssr` + `@supabase/supabase-js`) |
| Billing | Stripe (one-time token packs + monthly subscriptions) |
| AI — промпти | Gemini 2.5 Flash (AI Studio або Vertex) |
| AI — зображення | Gemini 2.5 Flash Image Preview (AI Studio або Vertex) |
| Fallback | Vertex AI з Service Account (для $300 trial credits) |
| Integrations | Google Drive OAuth (аплоад згенерованих фото) |

> **Note:** Next.js 16 називає middleware-файл `proxy.ts` (а не `middleware.ts`). Це нова конвенція — див. `proxy.ts` у корені.

## Структура

```
app/
  (auth)/login,register      — auth pages
  auth/callback              — Supabase OAuth callback
  api/
    generate                 — SSE-стрім: 8 промптів → 8 зображень → Drive → DB
    billing/{checkout,portal,webhook}
    auth/google/{route,callback,disconnect}  — Drive OAuth
    admin/settings, user/settings
  dashboard/{generate,batch,history,settings,tokens}
  admin/{settings,users,analytics}
  pricing, page.tsx (landing)
lib/
  gemini.ts                  — generatePrompts + generateImage (Studio/Vertex routing)
  vertex-auth.ts             — Service Account → access token
  tokens.ts                  — resolveApiKey + deductTokens + creditTokens (BYOK/platform)
  stripe.ts                  — TOKEN_PACKS + SUBSCRIPTION_PLANS config
  crypto.ts                  — AES-256-GCM шифрування API-ключів
  google-drive.ts            — папки + аплоад
  supabase/{client,server,admin,storage}
  constants.ts               — ADMIN_EMAIL
supabase/migrations/         — 5 SQL міграцій
proxy.ts                     — auth middleware (Next 16 conv.)
```

## Налаштування

### 1. Залежності

```bash
npm install
```

### 2. Environment variables

Створи `.env.local` у корені. Повний список змінних, які використовуються в коді:

```env
# ── Supabase ────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# ── App ─────────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000
ADMIN_EMAIL=criptomtp@gmail.com
ENCRYPTION_KEY=                       # 32 байти, hex (для AES-256-GCM)

# ── Stripe ──────────────────────────────────────────────────
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_TOKENS_10=
STRIPE_PRICE_TOKENS_50=
STRIPE_PRICE_TOKENS_200=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PRO=

# ── Google OAuth (для Drive integration) ────────────────────
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# ── Vertex AI (опційно — fallback замість AI Studio platform key) ──
GOOGLE_VERTEX_SA_KEY=                 # JSON Service Account (одним рядком або base64)
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=us-central1
VERTEX_PROMPT_MODEL=gemini-2.5-flash
VERTEX_IMAGE_MODEL=gemini-2.5-flash-image-preview
```

Порядок резолву Gemini-ключа (`lib/tokens.ts:resolveApiKey`):
1. Якщо в юзера збережено власний ключ у профілі — використовується BYOK (без списання токенів).
2. Якщо `GOOGLE_VERTEX_SA_KEY` встановлено — Vertex AI.
3. Інакше — platform key з `platform_settings.gemini_api_key` (адмінська настройка).

### 3. Supabase міграції

Запусти у такому порядку через SQL Editor (або CLI):

1. `20260318000001_initial_schema.sql` — profiles, generations, platform_settings
2. `20260319000002_token_system.sql` — token_balance, token_transactions
3. `20260319000003_deduct_tokens_fn.sql` — atomic deduct
4. `20260319000004_google_token_expiry.sql` — Drive token refresh
5. `20260331000005_credit_tokens_fn.sql` — atomic credit + increment_generations_used

Створити Storage bucket (один раз):

```sql
insert into storage.buckets (id, name, public) values ('generations', 'generations', true);
```

(Код виконує `ensureBucket()` автоматично — `lib/supabase/storage.ts`.)

### 4. Stripe

Створити продукти + Prices в Dashboard, ID підкласти у `STRIPE_PRICE_*`. Зареєструвати webhook на `/api/billing/webhook` з подіями: `checkout.session.completed`, `customer.subscription.*`.

### 5. Google Cloud (опційно — для Vertex AI)

```bash
gcloud iam service-accounts create photoforge-vertex
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:photoforge-vertex@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
gcloud iam service-accounts keys create key.json \
  --iam-account=photoforge-vertex@$PROJECT.iam.gserviceaccount.com
```

JSON-вміст `key.json` запхати у `GOOGLE_VERTEX_SA_KEY`.

## Команди

```bash
npm run dev      # next dev (Turbopack)
npm run build    # next build
npm start        # next start
npx tsc --noEmit # type-check
```

## Архітектурні рішення

- **Token cost:** `prompt_gen=0.10 + image_gen=0.50 × 8 = 4.10` токенів на повну генерацію (`lib/tokens.ts:TOKEN_COSTS`).
- **Free plan:** `generations_used < generations_limit` пропускає списання токенів.
- **Encryption:** усі API-ключі (Gemini BYOK, Google Drive refresh tokens) шифруються AES-256-GCM (`lib/crypto.ts`) — ключ у `ENCRYPTION_KEY`.
- **Atomic DB ops:** `deduct_tokens`, `credit_tokens`, `increment_generations_used` — SQL-функції з row-level лок, безпечні від race conditions.
- **SSE стрім:** `/api/generate` шле `status → prompts_ready → image_start/done × 8 → done`. `maxDuration = 300s`.
- **Drive аплоад:** ре-фетч з Supabase Storage у Drive (опційно, якщо юзер під'єднав Google Drive).

## Що не реалізовано

- `/dashboard/batch` — це **stub** (13 рядків). Масова генерація з CSV/Google Sheets обіцяна на лендінгу, але не побудована.
- Тести відсутні.
