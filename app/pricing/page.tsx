import Link from "next/link";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe";

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "/місяць",
    features: ["5 генерацій/міс", "Водяний знак", "Збереження 7 днів"],
    cta: "Почати безкоштовно",
    href: "/register",
    accent: false,
  },
  ...SUBSCRIPTION_PLANS.map((plan) => ({
    name: plan.label,
    price: `$${plan.usd}`,
    period: "/місяць",
    features: plan.features,
    cta: `Обрати ${plan.label}`,
    href: "/dashboard/tokens",
    accent: plan.id === "pro",
  })),
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    features: ["Необмежено", "Виділений сервер", "Кастомні промпти", "SLA"],
    cta: "Зв'язатися",
    href: "mailto:hello@photoforge.ai",
    accent: false,
  },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#0C0B0A]">
      <nav className="border-b border-[#2A2723] px-6 h-16 flex items-center justify-between max-w-7xl mx-auto">
        <Link href="/" className="font-heading text-xl font-bold text-[#E8943A]">PhotoForge</Link>
        <Link href="/login" className="bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A] text-sm font-medium px-4 py-2 rounded-lg transition-colors">
          Увійти
        </Link>
      </nav>

      <section className="max-w-7xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="font-heading text-4xl md:text-5xl font-bold text-[#F5F0EB] mb-4">
            Прості та прозорі тарифи
          </h1>
          <p className="text-[#6B6560] text-lg">Оберіть план, що підходить для вашого бізнесу</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`rounded-xl p-8 border flex flex-col ${
                plan.accent
                  ? "bg-[#1E1C19] border-[#E8943A]"
                  : "bg-[#161412] border-[#2A2723]"
              }`}
            >
              {plan.accent && (
                <span className="text-[#E8943A] text-xs font-medium tracking-widest uppercase mb-4">
                  Популярний
                </span>
              )}
              <h2 className="font-heading text-2xl font-bold text-[#F5F0EB]">{plan.name}</h2>
              <div className="mt-3 mb-6">
                <span className="font-heading text-4xl font-bold text-[#F5F0EB]">{plan.price}</span>
                <span className="text-[#6B6560]">{plan.period}</span>
              </div>

              <ul className="space-y-2 flex-1 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-[#6B6560]">
                    <span className="text-[#E8943A] mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <Link
                href={plan.href}
                className={`w-full text-center py-3 rounded-lg font-medium text-sm transition-colors ${
                  plan.accent
                    ? "bg-[#E8943A] hover:bg-[#D4832B] text-[#0C0B0A]"
                    : "border border-[#2A2723] hover:border-[#E8943A] text-[#F5F0EB]"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
