"use client";

import { useState, useRef } from "react";

const SEASONS = ["Зима", "Осінь", "Літо", "Демісезон"];
const GENDERS = ["Чоловіча", "Жіноча", "Хлопчик", "Дівчинка", "Унісекс"];

export default function GeneratePage() {
  const [brand, setBrand] = useState("");
  const [productType, setProductType] = useState("");
  const [season, setSeason] = useState("");
  const [gender, setGender] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 9);
    setImages(files);
    setPreviews(files.map((f) => URL.createObjectURL(f)));
  }

  function removeImage(idx: number) {
    const newImages = images.filter((_, i) => i !== idx);
    const newPreviews = previews.filter((_, i) => i !== idx);
    setImages(newImages);
    setPreviews(newPreviews);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // TODO: call /api/generate
    alert("Генерація буде реалізована на наступному кроці");
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">
          Генерація фото
        </h1>
        <p className="text-[#6B6560] mt-1">
          Заповніть форму та завантажте референс — отримайте 8 фото
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Бренд</label>
            <input
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Nike, Zara, H&M..."
              className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Вид товару</label>
            <input
              type="text"
              value={productType}
              onChange={(e) => setProductType(e.target.value)}
              placeholder="Пуховик, кросівки, сумка..."
              className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] placeholder-[#6B6560] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Сезонність</label>
            <select
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            >
              <option value="">Оберіть сезон</option>
              {SEASONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-[#6B6560] mb-2">Цільова аудиторія</label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full bg-[#161412] border border-[#2A2723] rounded-lg px-4 py-3 text-[#F5F0EB] focus:outline-none focus:border-[#E8943A] transition-colors"
              required
            >
              <option value="">Оберіть аудиторію</option>
              {GENDERS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Image Upload */}
        <div>
          <label className="block text-sm text-[#6B6560] mb-2">
            Референс-фото (до 9 зображень)
          </label>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-[#2A2723] hover:border-[#E8943A] rounded-xl p-8 text-center cursor-pointer transition-colors"
          >
            <p className="text-[#6B6560]">
              Натисніть або перетягніть фото сюди
            </p>
            <p className="text-[#6B6560] text-sm mt-1">PNG, JPG до 10MB кожне</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleImageChange}
          />

          {previews.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mt-4">
              {previews.map((src, idx) => (
                <div key={idx} className="relative group aspect-square">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={`ref ${idx + 1}`}
                    className="w-full h-full object-cover rounded-lg border border-[#2A2723]"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(idx)}
                    className="absolute top-1 right-1 bg-black/70 hover:bg-black text-white rounded-full w-6 h-6 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={!brand || !productType || !season || !gender || images.length === 0}
          className="w-full bg-[#E8943A] hover:bg-[#D4832B] disabled:opacity-40 disabled:cursor-not-allowed text-[#0C0B0A] font-semibold py-4 rounded-xl transition-colors text-lg"
        >
          Згенерувати 8 фото
        </button>
      </form>
    </div>
  );
}
