import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          ИИ Библиотекарь знаний
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Живая библиотека знаний для вашего бюро переводов.
          Загружайте документы, извлекайте правила и задавайте вопросы.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/playground"
            className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
          >
            Попробовать песочницу
          </Link>
          <Link
            href="/admin"
            className="inline-flex items-center justify-center px-6 py-3 border border-gray-300 text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 transition-colors"
          >
            Панель администратора
          </Link>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-8 text-left">
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Загрузка документов</h3>
            <p className="text-sm text-gray-600">
              Загружайте PDF, DOCX или TXT файлы. ИИ автоматически извлекает правила и пары вопрос-ответ.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Классификация доменов</h3>
            <p className="text-sm text-gray-600">
              ИИ классифицирует знания по доменам и предлагает новые категории при необходимости.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Задавайте вопросы</h3>
            <p className="text-sm text-gray-600">
              Запрашивайте базу знаний. Получайте ответы с источниками и показателями уверенности.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
