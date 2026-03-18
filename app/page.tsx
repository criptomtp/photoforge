import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0C0B0A]">
      {/* Nav */}
      <nav className="border-b border-[#2A2723] px-6 h-16 flex items-center justify-between max-w-7xl mx-auto">
        <span className="font-heading text-xl font-bold text-[#E8943A]">PhotoForge</span>
        <div className="flex items-center gap-4">
          <Link href="/pricing" className="text-sm text-[#6B6560] hover:text-[#F5F0EB] transition-colors">
            Тарифи
          </Link>
          <Link
            href="/login"
            className="bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Увійти
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-6 py-24 text-center">
        <p className="text-[#E8943A] text-sm font-medium tracking-widest uppercase mb-6">
          AI Product Photography
        </p>
        <h1 className="font-heading text-5xl md:text-7xl font-bold text-[#F5F0EB] leading-tight mb-6">
          Професійні фото товарів
          <br />
          <span className="text-[#E8943A]">за секунди</span>
        </h1>
        <p className="text-[#6B6560] text-lg md:text-xl max-w-2xl mx-auto mb-12">
          Завантажте референс-фото та опис товару — отримайте 8 фотореалістичних знімків
          з різних ракурсів з моделлю. Powered by Google Gemini AI.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/register"
            className="bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] font-semibold px-8 py-4 rounded-xl transition-colors text-lg"
          >
            Почати безкоштовно
          </Link>
          <Link
            href="/pricing"
            className="border border-[#2A2723] hover:border-[#E8943A] text-[#F5F0EB] font-medium px-8 py-4 rounded-xl transition-colors text-lg"
          >
            Переглянути тарифи
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            { icon: "🎯", title: "8 ракурсів одразу", desc: "Full-body, side, back, close-up, action — все в одному запуску" },
            { icon: "👤", title: "Реальна модель", desc: "Слов'янська модель, обраний сезон та гендер аудиторії" },
            { icon: "⚡", title: "Масова генерація", desc: "Google Sheets або Excel — сотні товарів автоматично" },
          ].map((f) => (
            <div key={f.title} className="bg-[#161412] border border-[#2A2723] rounded-xl p-8">
              <div className="text-4xl mb-4">{f.icon}</div>
              <h3 className="font-heading text-xl font-bold text-[#F5F0EB] mb-2">{f.title}</h3>
              <p className="text-[#6B6560]">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
