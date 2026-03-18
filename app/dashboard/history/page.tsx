export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-[#F5F0EB]">Історія генерацій</h1>
        <p className="text-[#6B6560] mt-1">Всі ваші згенеровані фото</p>
      </div>

      <div className="bg-[#161412] border border-[#2A2723] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#2A2723]">
              {["Товар", "Сезон", "Аудиторія", "Дата", "Фото", "Статус"].map((h) => (
                <th key={h} className="text-left text-[#6B6560] font-medium px-6 py-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} className="px-6 py-12 text-center text-[#6B6560]">
                Генерацій поки немає. <a href="/dashboard/generate" className="text-[#E8943A] hover:underline">Створити першу →</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
