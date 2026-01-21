import Link from 'next/link';
import {
  ArrowRight,
  FileText,
  Layers,
  MessageSquareText,
  Sparkles,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

const features = [
  {
    title: 'Загрузка документов',
    description:
      'Загружайте PDF, DOCX или TXT файлы. ИИ автоматически извлекает правила и пары вопрос-ответ.',
    icon: FileText,
  },
  {
    title: 'Классификация доменов',
    description:
      'ИИ классифицирует знания по доменам и предлагает новые категории при необходимости.',
    icon: Layers,
  },
  {
    title: 'Задавайте вопросы',
    description:
      'Запрашивайте базу знаний. Получайте ответы с источниками и показателями уверенности.',
    icon: MessageSquareText,
  },
];

const workflow = [
  {
    title: 'Импорт и анализ',
    description: 'Подключайте документы и сразу получайте структурированные сущности.',
  },
  {
    title: 'Извлечение правил',
    description: 'Система фиксирует термины, требования и контекст с источниками.',
  },
  {
    title: 'Ответы команде',
    description: 'Единый слой знаний для редакторов, PM и руководителей.',
  },
];

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-hero">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-35" />
      <div className="relative">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 pt-8">
          <Link
            href="/"
            className="font-display text-lg font-semibold tracking-tight text-slate-900"
          >
            ИИ Библиотекарь знаний
          </Link>
          <div className="hidden items-center gap-3 sm:flex">
            <Button variant="ghost" asChild className="text-slate-600">
              <Link href="/admin">Панель администратора</Link>
            </Button>
            <Button asChild className="rounded-full bg-slate-900 px-5 text-white hover:bg-slate-800">
              <Link href="/playground">
                Песочница
              </Link>
            </Button>
          </div>
        </header>

        <main className="mx-auto flex max-w-6xl flex-col gap-16 px-6 pb-24 pt-12">
          <section className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-6">
              <Badge
                variant="outline"
                className="border-amber-200/80 bg-white/70 text-slate-700 animate-fade-rise motion-reduce:animate-none [animation-delay:80ms]"
              >
                <Sparkles className="text-amber-500" />
                Экосистема знаний для бюро переводов
              </Badge>
              <div className="space-y-4">
                <h1 className="font-display text-4xl font-semibold leading-tight text-slate-900 sm:text-5xl lg:text-6xl animate-fade-rise motion-reduce:animate-none [animation-delay:140ms]">
                  Полированная
                  <span className="text-gradient"> библиотека знаний</span>
                  <br />
                  для переводческих команд.
                </h1>
                <p className="text-lg text-slate-600 sm:text-xl animate-fade-rise motion-reduce:animate-none [animation-delay:200ms]">
                  Живая библиотека знаний, которая соединяет документы, правила и ответы в единый
                  поток с прозрачными источниками.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row animate-fade-rise motion-reduce:animate-none [animation-delay:260ms]">
                <Button
                  asChild
                  className="h-11 rounded-full bg-slate-900 px-6 text-white shadow-elevated hover:bg-slate-800"
                >
                  <Link href="/playground">
                    Попробовать песочницу
                    <ArrowRight />
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="h-11 rounded-full border-slate-300/80 bg-white/70 text-slate-700 hover:bg-white"
                >
                  <Link href="/admin">Панель администратора</Link>
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500 animate-fade-rise motion-reduce:animate-none [animation-delay:320ms]">
                <span className="flex items-center gap-2">
                  <Zap className="size-4 text-emerald-500" />
                  Мгновенные ответы
                </span>
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-slate-700" />
                  Проверенные источники
                </span>
              </div>
            </div>

            <div className="relative animate-fade-rise motion-reduce:animate-none [animation-delay:180ms]">
              <div className="absolute -right-8 top-6 h-40 w-40 rounded-full bg-emerald-200/50 blur-3xl" />
              <div className="absolute -left-10 bottom-10 h-40 w-40 rounded-full bg-amber-200/50 blur-3xl" />
              <Card className="glass-panel relative overflow-hidden rounded-3xl border-white/60 py-0 animate-float-soft motion-reduce:animate-none">
                <CardHeader className="space-y-2 px-6 pb-0 pt-6">
                  <div className="flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-500">
                    Сеанс запроса
                    <Badge className="bg-emerald-500/90 text-white">Live</Badge>
                  </div>
                  <div className="text-lg font-semibold text-slate-900">
                    Ответы с контекстом и ссылками
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 px-6 pb-6">
                  <div className="rounded-2xl border border-slate-200/70 bg-white/80 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
                      Вопрос
                    </div>
                    <p className="mt-2 text-sm text-slate-700">
                      Как переводить SLA в договоре для B2B клиента?
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-900 p-4 text-slate-100 shadow-elevated">
                    <div className="flex items-center justify-between text-xs uppercase tracking-[0.15em] text-slate-400">
                      Ответ
                      <span className="rounded-full bg-white/10 px-2 py-1 text-[10px]">
                        92% уверенности
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-200">
                      Используйте «уровень сервиса» при первом упоминании и сохраняйте аббревиатуру SLA
                      далее по тексту.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
                      <span className="rounded-full bg-white/10 px-3 py-1">Правило 12.4</span>
                      <span className="rounded-full bg-white/10 px-3 py-1">Contract Guide</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="grid gap-6 md:grid-cols-3 animate-fade-rise motion-reduce:animate-none [animation-delay:380ms]">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <Card
                  key={feature.title}
                  className="glass-panel rounded-2xl border-white/60 py-0 transition duration-300 hover:-translate-y-1 hover:shadow-elevated"
                >
                  <CardContent className="p-6">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-slate-900 shadow-sm">
                        <Icon className="size-5 text-slate-700" />
                      </div>
                      <h3 className="text-base font-semibold text-slate-900">{feature.title}</h3>
                    </div>
                    <p className="mt-3 text-sm text-slate-600">{feature.description}</p>
                  </CardContent>
                </Card>
              );
            })}
          </section>

          <section className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] animate-fade-rise motion-reduce:animate-none [animation-delay:440ms]">
            <Card className="glass-panel rounded-3xl border-white/60 py-0">
              <CardContent className="space-y-6 p-6">
                <div className="flex items-center gap-3 text-sm font-semibold text-slate-800">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <Zap className="size-4" />
                  </span>
                  Уверенность и прозрачность
                </div>
                <p className="text-sm text-slate-600">
                  Каждое правило и ответ закреплены источником. Команда сразу видит происхождение
                  знания и уровень уверенности.
                </p>
                <div className="grid gap-3 text-sm text-slate-600">
                  {workflow.map((item, index) => (
                    <div key={item.title} className="flex gap-3">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
                        {index + 1}
                      </div>
                      <div>
                        <div className="font-semibold text-slate-900">{item.title}</div>
                        <div className="text-xs text-slate-500">{item.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-6">
              <Card className="glass-panel rounded-3xl border-white/60 py-0">
                <CardContent className="space-y-4 p-6">
                  <div className="text-sm font-semibold text-slate-900">
                    Контроль качества ответа
                  </div>
                  <p className="text-sm text-slate-600">
                    Система отображает домены, источники и метрики уверенности, чтобы проверка
                    занимала секунды.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="border-slate-200/70 bg-white/80 text-slate-700">
                      Домены
                    </Badge>
                    <Badge variant="outline" className="border-slate-200/70 bg-white/80 text-slate-700">
                      Источники
                    </Badge>
                    <Badge variant="outline" className="border-slate-200/70 bg-white/80 text-slate-700">
                      Уверенность
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-0 bg-slate-900 py-0 text-white shadow-elevated">
                <CardContent className="space-y-4 p-6">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">Готовы ускорить ответы?</span>
                    <Badge className="bg-white/10 text-white">Beta</Badge>
                  </div>
                  <p className="text-sm text-slate-300">
                    Запустите песочницу и задайте первые вопросы, чтобы увидеть ответы в действии.
                  </p>
                  <Button asChild className="rounded-full bg-white text-slate-900 hover:bg-slate-100">
                    <Link href="/playground">
                      Перейти в песочницу
                      <ArrowRight />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
