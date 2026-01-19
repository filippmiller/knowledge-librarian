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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <Link href="/admin" className="font-bold text-xl">
              Библиотека знаний
            </Link>
            <Link
              href="/playground"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Песочница
            </Link>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8 overflow-x-auto">
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'py-4 px-1 border-b-2 text-sm font-medium whitespace-nowrap',
                  pathname === item.href
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                )}
              >
                {item.name}
              </Link>
            ))}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
