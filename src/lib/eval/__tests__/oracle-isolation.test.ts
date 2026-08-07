import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSourceReferences } from '../source-scan';
import { SOURCE_DOCX_FILENAME } from '../semantic-rule-oracle';

/**
 * ВОРОТА ИЗОЛЯЦИИ ORACLE — план §0.3, acceptance criterion PR H:
 * «изоляция oracle соблюдена и ПРОВЕРЯЕМА: test_cases_semantic_rules.jsonl и
 * kontrolnye_voprosy_i_klyuch.md не попадают ни в базу знаний, ни в extraction
 * prompt, ни во вход answering engine (тест на это — не только
 * договорённость)».
 *
 * ПОЧЕМУ ПРОВЕРКА ИНВЕРТИРОВАНА. Первая версия перечисляла точки входа движка
 * и обходила их граф импортов — то есть была fail-open: новый модуль движка
 * оставался непроверенным, пока кто-нибудь не вспомнит дописать его в список.
 * Теперь проверяется ВЕСЬ `src/`, а исключения перечислены явно: раннер и
 * грейдер. Новый файл движка попадает под ворота автоматически.
 *
 * Это же правило закрывает обход через динамический импорт барреля: продуктовому
 * коду запрещён импорт из `@/lib/eval` ЦЕЛИКОМ, а не только «плохих» строк,
 * поэтому промежуточный ре-экспорт не даёт ничего.
 *
 * Чего эти ворота НЕ доказывают: они статические. Раннер, которому чтение
 * oracle разрешено, может передать `expectedAnswer` во вход движка — это
 * рантайм-граница, и её стережёт `assertNoOracleLeakage` (см. oracle-taint.ts).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Каталог раннера/грейдера: единственное место в `src/`, где oracle читать можно (§0.3 №3). */
const EVAL_DIR_PREFIX = 'src/lib/eval/';

/** Файлы oracle. DOCX сюда НЕ входит — это единственный источник знания (§0.3 №1). */
const ORACLE_FILENAMES = [
  'test_cases_semantic_rules.jsonl',
  'kontrolnye_voprosy_i_klyuch.md',
] as const;

const FORBIDDEN_LITERAL_FRAGMENTS = [
  ...ORACLE_FILENAMES,
  'semantic-rule-extraction-test-pack',
  'semantic-rule-oracle',
] as const;

const toRepoRelative = (file: string) => path.relative(REPO_ROOT, file).replace(/\\/g, '/');

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Весь продуктовый код: `src/` за вычетом каталога раннера/грейдера. */
const PRODUCT_FILES = collectSourceFiles(SRC_ROOT).filter(
  (file) => !toRepoRelative(file).startsWith(EVAL_DIR_PREFIX)
);

describe('изоляция oracle от продуктового кода', () => {
  it('под воротами оказывается реальный объём кода, а не пустое множество', () => {
    expect(PRODUCT_FILES.length).toBeGreaterThan(50);
    expect(
      PRODUCT_FILES.some((f) => toRepoRelative(f) === 'src/lib/knowledge/semantic-retrieval.ts')
    ).toBe(true);
    expect(
      PRODUCT_FILES.some((f) => toRepoRelative(f).startsWith('src/lib/ai/')),
      'движок ответа обязан быть под воротами'
    ).toBe(true);
  });

  it('продуктовый код не импортирует ничего из lib/eval — ни статически, ни динамически', () => {
    const violations: string[] = [];

    for (const file of PRODUCT_FILES) {
      const { moduleSpecifiers } = scanSourceReferences(file);
      for (const specifier of moduleSpecifiers) {
        const normalized = specifier.replace(/\\/g, '/');
        const reachesEval =
          normalized.includes('lib/eval') ||
          (normalized.startsWith('.') &&
            path
              .resolve(path.dirname(file), normalized)
              .replace(/\\/g, '/')
              .includes('/src/lib/eval/'));
        if (reachesEval) violations.push(`${toRepoRelative(file)} → ${specifier}`);
      }
    }

    expect(violations, 'продуктовый код тянет evaluation-only модуль').toEqual([]);
  });

  it('продуктовый код не упоминает файлы oracle строковым литералом', () => {
    const violations: string[] = [];

    for (const file of PRODUCT_FILES) {
      const { stringLiterals } = scanSourceReferences(file);
      for (const literal of stringLiterals) {
        for (const fragment of FORBIDDEN_LITERAL_FRAGMENTS) {
          if (literal.includes(fragment)) {
            violations.push(`${toRepoRelative(file)} → ${fragment}`);
          }
        }
      }
    }

    expect(violations, 'обращение к oracle в обход графа импортов').toEqual([]);
  });

  it('продуктовый код не зашивает путь к учебному DOCX — источник передаёт раннер', () => {
    const violations: string[] = [];

    for (const file of PRODUCT_FILES) {
      const { stringLiterals } = scanSourceReferences(file);
      if (stringLiterals.some((literal) => literal.includes(SOURCE_DOCX_FILENAME))) {
        violations.push(toRepoRelative(file));
      }
    }

    expect(violations).toEqual([]);
  });

  it('запрет в КОММЕНТАРИИ не считается нарушением — иначе документация ломает ворота', () => {
    const concepts = path.join(SRC_ROOT, 'lib/knowledge/applicability/concepts.ts');
    const raw = fs.readFileSync(concepts, 'utf8');

    expect(raw, 'фикстура этого утверждения исчезла').toContain(
      'semantic-rule-extraction-test-pack'
    );
    expect(
      scanSourceReferences(concepts).stringLiterals.join(' ')
    ).not.toContain('semantic-rule-extraction-test-pack');
  });
});
