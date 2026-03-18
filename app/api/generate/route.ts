import { createClient } from "@/lib/supabase/server";
import { generatePrompts, generateImage, type GeminiImagePart } from "@/lib/gemini";
import { ensureBucket, uploadImage } from "@/lib/supabase/storage";

export const maxDuration = 300; // 5 min timeout for Vercel

type SSEEvent =
  | { type: "status"; message: string }
  | { type: "prompts_ready"; count: number }
  | { type: "image_start"; index: number; total: number; angle: string }
  | { type: "image_done"; index: number; url: string }
  | { type: "done"; generationId: string; urls: string[] }
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
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      };

      try {
        // ── 1. Parse form data ──────────────────────────────────────────────
        const formData = await request.formData();
        const brand = formData.get("brand") as string;
        const productType = formData.get("productType") as string;
        const season = formData.get("season") as string;
        const gender = formData.get("gender") as string;
        const imageFiles = formData.getAll("images") as File[];

        if (!brand || !productType || !season || !gender || imageFiles.length === 0) {
          send({ type: "error", message: "Заповніть всі поля та завантажте хоча б одне фото" });
          controller.close();
          return;
        }

        // ── 2. Auth check ───────────────────────────────────────────────────
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
          send({ type: "error", message: "Необхідно авторизуватись" });
          controller.close();
          return;
        }

        // ── 3. Check generation limit ───────────────────────────────────────
        const { data: profile } = await supabase
          .from("profiles")
          .select("generations_used, generations_limit, plan")
          .eq("id", user.id)
          .single();

        if (profile && profile.generations_used >= profile.generations_limit) {
          send({
            type: "error",
            message: `Ліміт генерацій вичерпано (${profile.generations_used}/${profile.generations_limit}). Оновіть план на /pricing`,
          });
          controller.close();
          return;
        }

        // ── 4. Convert images to base64 ─────────────────────────────────────
        send({ type: "status", message: "Обробка зображень..." });

        const referenceParts: GeminiImagePart[] = await Promise.all(
          imageFiles.slice(0, 9).map(async (file) => {
            const buffer = await file.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");
            return {
              inline_data: {
                mime_type: "image/jpeg",
                data: base64,
              },
            };
          })
        );

        // ── 5. Create generation record in DB ──────────────────────────────
        const { data: generation, error: dbError } = await supabase
          .from("generations")
          .insert({
            user_id: user.id,
            brand,
            product_type: productType,
            season,
            gender,
            status: "processing",
          })
          .select()
          .single();

        if (dbError || !generation) {
          send({ type: "error", message: "Помилка бази даних" });
          controller.close();
          return;
        }

        const generationId: string = generation.id;
        const apiKey = process.env.GEMINI_API_KEY!;

        // ── 6. Generate 8 prompts via Gemini 2.5 Pro ───────────────────────
        send({ type: "status", message: "Генерую промпти з Gemini 2.5 Pro..." });

        const prompts = await generatePrompts(
          apiKey,
          brand,
          productType,
          season,
          gender,
          referenceParts
        );

        send({ type: "prompts_ready", count: prompts.length });

        // ── 7. Ensure storage bucket exists ────────────────────────────────
        await ensureBucket();

        // ── 8. Generate each image sequentially ───────────────────────────
        const imageUrls: string[] = [];

        for (let i = 0; i < prompts.length; i++) {
          const angleName = ANGLE_NAMES[i] ?? `Ракурс ${i + 1}`;
          send({ type: "image_start", index: i + 1, total: 8, angle: angleName });

          try {
            const base64Image = await generateImage(apiKey, prompts[i], referenceParts);

            // Upload to Supabase Storage
            const path = `${user.id}/${generationId}/${i + 1}.jpg`;
            const url = await uploadImage(base64Image, path);

            imageUrls.push(url);
            send({ type: "image_done", index: i + 1, url });

            // Update progress in DB
            await supabase
              .from("generations")
              .update({ images_generated: i + 1 })
              .eq("id", generationId);
          } catch (imgErr) {
            // Log but continue — one failed image shouldn't abort all
            console.error(`Image ${i + 1} failed:`, imgErr);
            imageUrls.push("");
            send({ type: "image_done", index: i + 1, url: "" });
          }
        }

        // ── 9. Finalize DB record ──────────────────────────────────────────
        await supabase
          .from("generations")
          .update({
            status: "done",
            images_generated: imageUrls.filter(Boolean).length,
            image_urls: imageUrls,
          })
          .eq("id", generationId);

        // Increment usage counter
        await supabase
          .from("profiles")
          .update({ generations_used: (profile?.generations_used ?? 0) + 1 })
          .eq("id", user.id);

        send({ type: "done", generationId, urls: imageUrls });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Невідома помилка";
        send({ type: "error", message });
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
