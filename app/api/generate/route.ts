import { createClient } from "@/lib/supabase/server";
import { generatePrompts, generateImage, imageInstructionsFor, type GeminiImagePart } from "@/lib/gemini";
import { ensureBucket, uploadImage } from "@/lib/supabase/storage";
import { resolveApiKey, reserveTokens, refundTokens } from "@/lib/tokens";
import { getAccessToken, createDriveFolder, uploadFileToDrive } from "@/lib/google-drive";
import { resolveAngles, costForAngles, refundForRun, netCostForRun, qualityTier } from "@/lib/angles";
import { category } from "@/lib/categories";

export const maxDuration = 300;

type SSEEvent =
  | { type: "status"; message: string }
  | { type: "prompts_ready"; count: number; prompts: string[]; generationId: string }
  | { type: "image_start"; index: number; total: number; angle: string }
  | { type: "image_done"; index: number; url: string; error?: string }
  | { type: "done"; generationId: string; urls: string[]; prompts: string[]; byok: boolean; driveUrl?: string; cost: number }
  | { type: "error"; message: string };

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: SSEEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // ── 1. Parse FormData ───────────────────────────────────────────────
        const formData = await request.formData();
        const cat         = category(formData.get("category")?.toString());
        const brand       = "";
        const productType = (formData.get("productType") as string) ?? "";
        const season      = (formData.get("season") as string) ?? "";
        const gender      = (formData.get("gender") as string) ?? "";
        const imageFiles  = formData.getAll("images") as File[];
        const angleIds    = formData.getAll("angles") as string[];
        const tier        = qualityTier(formData.get("quality")?.toString());

        if (imageFiles.length === 0) {
          send({ type: "error", message: "Завантажте хоча б одне референс-фото" });
          controller.close();
          return;
        }

        if (!productType.trim()) {
          send({ type: "error", message: "Вкажіть, який товар головний (напр. сорочка, джинси, кросівки)" });
          controller.close();
          return;
        }

        const angles = angleIds.length > 0 ? resolveAngles(angleIds, cat.angles) : [...cat.angles];
        if (angles.length === 0) {
          send({ type: "error", message: "Оберіть хоча б один ракурс" });
          controller.close();
          return;
        }
        const N = angles.length;

        // ── 2. Auth ─────────────────────────────────────────────────────────
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
          send({ type: "error", message: "Необхідно авторизуватись" });
          controller.close();
          return;
        }

        // ── 2b. Rate limit: cap how fast one account can start generations ──
        // Bounds abuse / runaway loops (financial overspend is already bounded
        // by the atomic token reserve, this stops request-flooding the API).
        const sinceIso = new Date(Date.now() - 60_000).toISOString();
        const { count: recentCount } = await supabase
          .from("generations")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("created_at", sinceIso);
        if ((recentCount ?? 0) >= 5) {
          send({ type: "error", message: "Забагато генерацій підряд. Зачекайте хвилину і спробуйте знову." });
          controller.close();
          return;
        }

        // ── 3. Resolve API key (BYOK or platform + token check) ────────────
        send({ type: "status", message: "Перевірка балансу..." });

        let apiKey: string | null;
        let byok: boolean;
        let freeQuota: boolean;
        let admin: boolean;

        try {
          ({ apiKey, byok, freeQuota, admin } = await resolveApiKey(user.id, user.email));
        } catch (err) {
          send({ type: "error", message: (err as Error).message });
          controller.close();
          return;
        }

        // ── 4. Convert images to base64 ─────────────────────────────────────
        send({ type: "status", message: "Обробка зображень..." });

        const referenceParts: GeminiImagePart[] = await Promise.all(
          imageFiles.slice(0, 9).map(async (file) => {
            const buffer = await file.arrayBuffer();
            return {
              inline_data: {
                mime_type: "image/jpeg",
                data: Buffer.from(buffer).toString("base64"),
              },
            };
          })
        );

        // ── 5. Create generation record ────────────────────────────────────
        const { data: generation, error: dbError } = await supabase
          .from("generations")
          .insert({ user_id: user.id, brand, product_type: productType, season, gender, category: cat.id, status: "processing" })
          .select()
          .single();

        if (dbError || !generation) {
          send({ type: "error", message: "Помилка бази даних" });
          controller.close();
          return;
        }

        const generationId: string = generation.id;

        // ── 5b. Reserve tokens / free slot UP-FRONT (before any paid AI call)
        // Charging the full N-image cost before generating closes the
        // "balance only checked for 1 image, deduction swallowed afterwards"
        // hole that let an underfunded user generate unlimited free images.
        if (!byok && !freeQuota && !admin) {
          try {
            await reserveTokens(user.id, generationId, N, tier.tokenMultiplier);
          } catch {
            await supabase
              .from("generations")
              .update({ status: "error", error_message: "insufficient_tokens" })
              .eq("id", generationId);
            send({
              type: "error",
              message: `Недостатньо токенів для ${N} ракурсів (потрібно ${costForAngles(N, tier.tokenMultiplier).toFixed(2)}). Поповніть баланс або додайте власний Gemini ключ.`,
            });
            controller.close();
            return;
          }
        } else if (freeQuota) {
          // Atomically consume one free-quota slot. A single conditional UPDATE
          // (in the RPC) closes the race where N concurrent requests each pass a
          // stale `generations_used < limit` check and all proceed for free.
          const { data: consumed, error: consumeErr } = await supabase.rpc(
            "try_consume_free_generation",
            { p_user_id: user.id }
          );
          if (consumeErr || consumed !== true) {
            await supabase
              .from("generations")
              .update({ status: "error", error_message: "free_quota_exhausted" })
              .eq("id", generationId);
            send({ type: "error", message: "Вичерпано безкоштовний ліміт генерацій. Поповніть баланс токенів." });
            controller.close();
            return;
          }
        }

        // ── 6. Generate 8 prompts via Gemini 2.5 Pro ───────────────────────
        const provider = byok ? "AI Studio (BYOK)" : apiKey === null ? "Vertex AI" : "AI Studio";
        send({ type: "status", message: `${provider}: генерую промпти...` });

        const prompts = await generatePrompts(apiKey, cat, productType, season, gender, referenceParts, angles);
        // Send the prompts NOW (not only in "done") so they show immediately and
        // survive even if image generation is slow or the request is cut short.
        send({ type: "prompts_ready", count: prompts.length, prompts, generationId });
        // Persist prompts up-front too, so the History page has them even if the
        // run is interrupted before the final write.
        await supabase.from("generations").update({ prompts }).eq("id", generationId);

        // ── 7. Generate images IN PARALLEL ─────────────────────────────────
        // Sequential generation (8 × ~20-40s) overruns Vercel Hobby's 60s cap and
        // strands the tail. A bounded concurrency pool runs them together so the
        // whole batch fits one short wave.
        await ensureBucket();
        const imageUrls: string[] = new Array(prompts.length).fill("");
        let imagesGenerated = 0;

        const generateOne = async (i: number): Promise<void> => {
          const angleName = angles[i]?.label ?? `Ракурс ${i + 1}`;
          send({ type: "image_start", index: i + 1, total: N, angle: angleName });

          // Image gen is flaky (safety re-rolls + transient errors); retry up to
          // 2× with short backoff. Each call is timeout-bounded inside generateImage.
          let base64Image: string | null = null;
          let lastErr = "";
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              base64Image = await generateImage(apiKey, prompts[i], referenceParts, tier.model, tier.location, imageInstructionsFor(cat, productType, season ? "lifestyle" : "catalog"));
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e.message : String(e);
              console.error(`Image ${i + 1} attempt ${attempt}/3 failed:`, lastErr);
              // 429/RESOURCE_EXHAUSTED is a Vertex quota throttle — back off longer
              // (with jitter) so the retry lands after the quota window refills.
              const rateLimited = /\b429\b|RESOURCE_EXHAUSTED/i.test(lastErr);
              if (attempt < 3) {
                const base = rateLimited ? 3500 : 700;
                await new Promise((r) => setTimeout(r, base * attempt + Math.floor(Math.random() * 600)));
              }
            }
          }

          if (base64Image) {
            try {
              const path = `${user.id}/${generationId}/${i + 1}.jpg`;
              const url  = await uploadImage(base64Image, path);
              imageUrls[i] = url;
              imagesGenerated++;
              send({ type: "image_done", index: i + 1, url });
            } catch (upErr) {
              const errMsg = upErr instanceof Error ? upErr.message : String(upErr);
              console.error(`Image ${i + 1} upload failed:`, errMsg);
              send({ type: "image_done", index: i + 1, url: "", error: errMsg });
            }
          } else {
            send({ type: "image_done", index: i + 1, url: "", error: lastErr });
          }
        };

        // Concurrency pool: workers pull indices off a shared queue. The binding
        // limit is the Vertex image-model QUOTA (429 RESOURCE_EXHAUSTED), not the
        // CPU — firing all 8 at once exhausts it. Keep it low (env-tunable) and
        // lean on the 429-aware backoff in generateOne. Pro's quota is tiny, so
        // Pro effectively needs CONCURRENCY=1-2 + a long time budget.
        const CONCURRENCY = Math.min(prompts.length, Number(process.env.IMAGE_CONCURRENCY) || 3);
        const queue = prompts.map((_, i) => i);
        await Promise.all(
          Array.from({ length: CONCURRENCY }, async () => {
            let idx: number | undefined;
            while ((idx = queue.shift()) !== undefined) {
              await generateOne(idx);
            }
          })
        );

        // ── 8. Upload to Google Drive if connected ─────────────────────────
        let driveFolderUrl: string | undefined;
        let driveFolderId: string | undefined;

        const driveToken = await getAccessToken(user.id).catch(() => null);
        if (driveToken && imagesGenerated > 0) {
          try {
            send({ type: "status", message: "Завантажую на Google Drive..." });
            const folderName = productType || `PhotoForge — ${cat.label}`;
            const { id: folderId, webViewLink } = await createDriveFolder(driveToken, folderName);
            driveFolderId = folderId;
            driveFolderUrl = webViewLink;

            // Raw base64 images aren't stored — re-fetch from Supabase Storage
            // and upload only successful ones
            const driveUploads = imageUrls.map(async (url, i) => {
              if (!url) return;
              try {
                const res = await fetch(url);
                const buf = await res.arrayBuffer();
                const b64 = Buffer.from(buf).toString("base64");
                await uploadFileToDrive(
                  driveToken,
                  folderId,
                  `${angles[i]?.label?.replace(/ /g, "_") ?? `angle_${i + 1}`}.jpg`,
                  b64
                );
              } catch (e) {
                console.error(`Drive upload ${i + 1} failed:`, e);
              }
            });
            await Promise.all(driveUploads);
          } catch (err) {
            console.error("Drive folder/upload failed:", err);
            // Non-fatal
          }
        }

        // ── 9. Reconcile the reservation: refund tokens for failed images ──
        let cost = 0;
        if (!byok && !freeQuota && !admin) {
          const refund = refundForRun(N, imagesGenerated, tier.tokenMultiplier);
          if (refund > 0) {
            const failed = N - imagesGenerated;
            await refundTokens(
              user.id,
              generationId,
              refund,
              imagesGenerated === 0
                ? "Повернення: жодного фото не згенеровано"
                : `Повернення за ${failed} невдалих фото`
            ).catch((e) => console.error("Token refund failed:", e));
          }
          cost = netCostForRun(N, imagesGenerated, tier.tokenMultiplier);
        }

        // ── 10. Finalise DB ────────────────────────────────────────────────
        await supabase
          .from("generations")
          .update({
            status: "done",
            images_generated: imagesGenerated,
            image_urls: imageUrls,
            prompts,
            ...(driveFolderId ? { google_drive_folder_id: driveFolderId } : {}),
            ...(driveFolderUrl ? { google_drive_folder_url: driveFolderUrl } : {}),
          })
          .eq("id", generationId);

        // Usage counter: paid/BYOK runs counted here; free runs counted up-front.
        // Admin (owner) runs are unlimited and not counted.
        if (!freeQuota && !admin) {
          await supabase.rpc("increment_generations_used", { p_user_id: user.id });
        }

        send({ type: "done", generationId, urls: imageUrls, prompts, byok, driveUrl: driveFolderUrl, cost });
        controller.close();
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "Невідома помилка" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
