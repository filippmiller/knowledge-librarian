'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const navigation = [
  { name: 'Документы', href: '/admin/documents' },
  { name: 'Домены', href: '/admin/domains' },
  { name: 'Предложения доменов', href: '/admin/domain-suggestions' },
  { name: 'Правила', href: '/admin/rules' },
  { name: 'Вопросы и ответы', href: '/admin/qa' },
  { name: 'Вопросы ИИ', href: '/admin/ai-questions' },
  { name: 'Журнал изменений', href: '/admin/knowledge-changes' },
  { name: 'Настройки ИИ', href: '/admin/ai-settings' },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="relative min-h-screen overflow-hidden bg-hero">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-30" />
      <div className="relative">
        <header className="border-b border-white/70 bg-white/75 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
            <Link href="/admin" className="font-display text-lg font-semibold text-slate-900">
              Библиотека знаний
            </Link>
            <Link
              href="/playground"
              className="rounded-full border border-slate-200/70 bg-white/80 px-4 py-2 text-sm text-slate-600 transition hover:bg-white hover:text-slate-900"
            >
              Песочница
            </Link>
          </div>
        </header>

        <nav className="border-b border-white/70 bg-white/70 backdrop-blur">
          <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex flex-wrap gap-2">
              {navigation.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded-full px-4 py-2 text-sm font-medium transition',
                    pathname === item.href
                      ? 'bg-slate-900 text-white shadow-elevated'
                      : 'text-slate-600 hover:bg-white hover:text-slate-900'
                  )}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          </div>
        </nav>

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
