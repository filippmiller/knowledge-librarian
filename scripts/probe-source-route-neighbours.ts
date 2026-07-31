/**
 * Замер на проде по формулировкам, которые детерминированная ветка НЕ ловит.
 *
 * Смысл: ветка source-document-route перехватывает прямой вопрос про исходник,
 * поэтому её ответ не зависит от базы. Эффект правки правил виден только на
 * СОСЕДНИХ формулировках, где ответ по-прежнему собирает поиск по смыслу.
 * Скрипт сначала проверяет, что ветка на этих вопросах действительно молчит,
 * а потом спрашивает прод анонимно (клиентский контур).
 *
 * Запуск: npx tsx scripts/probe-source-route-neighbours.ts <before|after>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveSourceDocumentRoute } from '../src/lib/knowledge/source-document-route';

const PROD = 'https://avrora-library-production.up.railway.app/api/ask';

const QUESTIONS = [
  'В чём разница между обычной ксерокопией и нотариально заверенной копией документа?',
  'Какой пакет документов нужен для подачи перевода в суд?',
  'Что вы прикладываете к переводу, который пойдёт в посольство?',
  'Чем отличается перевод, сделанный с ксерокопии, от перевода с нотариальной копии?',
  'Обязательно ли делать нотариальную копию перед переводом документа?',
  'Я живу в другом городе, приехать не смогу. Как заказать перевод справки о несудимости?',
];

type Probe = {
  question: string;
  branch: string;
  answerSource?: string;
  delivery?: string;
  requiresHumanReview?: boolean;
  answerWithheld?: boolean;
  confidence?: number;
  answer?: string;
  error?: string;
};

/**
 * `includeDebug` здесь не ради отладочной нагрузки, а чтобы обойти кэш ответов:
 * он живёт в памяти процесса 30 минут и правкой базы не сбрасывается. Без этого
 * замер «после» вернул бы дословно ответ «до» и ничего не доказал.
 */
async function ask(question: string, bypassCache: boolean): Promise<Partial<Probe>> {
  const res = await fetch(PROD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bypassCache ? { question, includeDebug: true } : { question }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const j = (await res.json()) as Record<string, unknown>;
  return {
    answerSource: j.answerSource as string | undefined,
    delivery: j.delivery as string | undefined,
    requiresHumanReview: j.requiresHumanReview as boolean | undefined,
    answerWithheld: j.answerWithheld as boolean | undefined,
    confidence: j.confidence as number | undefined,
    answer: typeof j.answer === 'string' ? j.answer : JSON.stringify(j).slice(0, 400),
  };
}

async function main() {
  const phase = process.argv[2] === 'after' ? 'after' : 'before';
  const bypassCache = process.argv.includes('--no-cache');
  const out: Probe[] = [];

  for (const q of QUESTIONS) {
    const branch = resolveSourceDocumentRoute(q).kind;
    process.stdout.write(`\n### ${q}\n  ветка: ${branch}\n`);
    const r = await ask(q, bypassCache);
    const probe: Probe = { question: q, branch, ...r };
    out.push(probe);
    if (probe.error) {
      console.log(`  ОШИБКА: ${probe.error}`);
      continue;
    }
    console.log(
      `  answerSource=${probe.answerSource} delivery=${probe.delivery} ` +
        `requiresHumanReview=${probe.requiresHumanReview} answerWithheld=${probe.answerWithheld} ` +
        `confidence=${probe.confidence?.toFixed(2)}`
    );
    console.log(`  ответ: ${(probe.answer ?? '').replace(/\s+/g, ' ')}`);
    // Прод не должен схлопывать вопросы в один и тот же кэш-ключ — они разные,
    // но соседние запросы подряд ловят общий рейт-лимит.
    await new Promise((r2) => setTimeout(r2, 1500));
  }

  const file = resolve(process.cwd(), `.probe/source-route-${phase}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\nсохранено: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
