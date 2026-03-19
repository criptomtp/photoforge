import { createClient } from "@/lib/supabase/server";
import { generatePrompts, generateImage, type GeminiImagePart } from "@/lib/gemini";
import { ensureBucket, uploadImage } from "@/lib/supabase/storage";
import { resolveApiKey, deductTokens } from "@/lib/tokens";

export const maxDuration = 300;

type SSEEvent =
  | { type: "status"; message: string }
  | { type: "prompts_ready"; count: number }
  | { type: "image_start"; index: number; total: number; angle: string }
  | { type: "image_done"; index: number; url: string }
  | { type: "done"; generationId: string; urls: string[]; byok: boolean }
  | { type: "error"; message: string };

const ANGLE_NAMES = [
  "Full-body front",
  "Full-body side",
  "Full-body back",
  "3/4 front",
  "3/4 back",
  "Close-up detail",
  "Action shot",
  "Creative shot",
];

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
        const brand       = formData.get("brand") as string;
        const productType = formData.get("productType") as string;
        const season      = formData.get("season") as string;
        const gender      = formData.get("gender") as string;
        const imageFiles  = formData.getAll("images") as File[];

        if (!brand || !productType || !season || !gender || imageFiles.length === 0) {
          send({ type: "error", message: "Заповніть всі поля та завантажте хоча б одне фото" });
          controller.close();
          return;
        }

        // ── 2. Auth ─────────────────────────────────────────────────────────
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
          send({ type: "error", message: "Необхідно авторизуватись" });
          controller.close();
          return;
        }

        // ── 3. Resolve API key (BYOK or platform + token check) ────────────
        send({ type: "status", message: "Перевірка балансу..." });

        let apiKey: string;
        let byok: boolean;

        try {
          ({ apiKey, byok } = await resolveApiKey(user.id));
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
          .insert({ user_id: user.id, brand, product_type: productType, season, gender, status: "processing" })
          .select()
          .single();

        if (dbError || !generation) {
          send({ type: "error", message: "Помилка бази даних" });
          controller.close();
          return;
        }

        const generationId: string = generation.id;

        // ── 6. Generate 8 prompts via Gemini 2.5 Pro ───────────────────────
        send({ type: "status", message: "Gemini 2.5 Pro: генерую промпти..." });

        const prompts = await generatePrompts(apiKey, brand, productType, season, gender, referenceParts);
        send({ type: "prompts_ready", count: prompts.length });

        // ── 7. Generate images via Gemini 2.5 Flash ────────────────────────
        await ensureBucket();
        const imageUrls: string[] = [];
        let imagesGenerated = 0;

        for (let i = 0; i < prompts.length; i++) {
          const angleName = ANGLE_NAMES[i] ?? `Ракурс ${i + 1}`;
          send({ type: "image_start", index: i + 1, total: 8, angle: angleName });

          try {
            const base64Image = await generateImage(apiKey, prompts[i], referenceParts);
            const path = `${user.id}/${generationId}/${i + 1}.jpg`;
            const url  = await uploadImage(base64Image, path);

            imageUrls.push(url);
            imagesGenerated++;
            send({ type: "image_done", index: i + 1, url });

            await supabase
              .from("generations")
              .update({ images_generated: imagesGenerated })
              .eq("id", generationId);
          } catch (imgErr) {
            console.error(`Image ${i + 1} failed:`, imgErr);
            imageUrls.push("");
            send({ type: "image_done", index: i + 1, url: "" });
          }
        }

        // ── 8. Deduct tokens if using platform key ─────────────────────────
        if (!byok && imagesGenerated > 0) {
          try {
            await deductTokens(user.id, generationId, imagesGenerated);
          } catch (err) {
            console.error("Token deduction failed:", err);
            // Non-fatal — generation already done
          }
        }

        // ── 9. Finalise DB ─────────────────────────────────────────────────
        await supabase
          .from("generations")
          .update({ status: "done", images_generated: imagesGenerated, image_urls: imageUrls })
          .eq("id", generationId);

        // Increment usage counter
        const { data: pf } = await supabase
          .from("profiles")
          .select("generations_used")
          .eq("id", user.id)
          .single();
        if (pf) {
          await supabase
            .from("profiles")
            .update({ generations_used: pf.generations_used + 1 })
            .eq("id", user.id);
        }

        send({ type: "done", generationId, urls: imageUrls, byok });
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
