import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSourceReferences } from '../source-scan';

/**
 * Сканер ссылок на основе AST TypeScript (Beads translation-yz9 / PR H).
 *
 * Ворота изоляции oracle обязаны быть НЕобманываемыми, поэтому разбор ведёт
 * настоящий компилятор, а не регулярка: комментарии в AST не попадают вовсе,
 * а regex-литералы и вложенные шаблонные строки — забота парсера, а не наша.
 */

let root: string;

const scanText = (contents: string) => {
  const file = path.join(root, `case-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(file, contents, 'utf8');
  return scanSourceReferences(file);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-scan-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanSourceReferences — specifier-ы модулей', () => {
  it('видит статический импорт', () => {
    expect(scanText("import { a } from '@/lib/target';").moduleSpecifiers).toContain(
      '@/lib/target'
    );
  });

  it('видит export ... from', () => {
    expect(scanText("export * from './reexported';").moduleSpecifiers).toContain('./reexported');
  });

  it('видит import type', () => {
    expect(scanText("import type { T } from './typed';").moduleSpecifiers).toContain('./typed');
  });

  it('видит ДИНАМИЧЕСКИЙ import() — обход графа через него был бы утечкой', () => {
    expect(
      scanText("const m = await import('@/lib/eval/oracle-tools');").moduleSpecifiers
    ).toContain('@/lib/eval/oracle-tools');
  });

  it('видит require()', () => {
    expect(scanText("const m = require('@/lib/eval/oracle-tools');").moduleSpecifiers).toContain(
      '@/lib/eval/oracle-tools'
    );
  });
});

describe('scanSourceReferences — строковые литералы', () => {
  it('собирает обычные строки', () => {
    expect(scanText("const p = 'test_cases_semantic_rules.jsonl';").stringLiterals).toContain(
      'test_cases_semantic_rules.jsonl'
    );
  });

  it('собирает текстовые части шаблонных строк', () => {
    expect(
      scanText('const p = `dir/test_cases_semantic_rules.jsonl`;').stringLiterals.join(' ')
    ).toContain('test_cases_semantic_rules.jsonl');
  });

  it('НЕ собирает комментарии — запрет в документации не является нарушением', () => {
    const scanned = scanText(
      '// не читать test_cases_semantic_rules.jsonl\n/** и kontrolnye_voprosy_i_klyuch.md тоже */\nconst a = 1;'
    );

    expect(scanned.stringLiterals.join(' ')).not.toContain('test_cases_semantic_rules');
    expect(scanned.stringLiterals.join(' ')).not.toContain('kontrolnye_voprosy');
  });
});

describe('scanSourceReferences — устойчивость к синтаксису, ломавшему ручной лексер', () => {
  it('regex-литерал с // не прячет следующий за ним запрещённый доступ', () => {
    const scanned = scanText(
      "const n = 1 / /[//]/.test('/') ; const leak = readFileSync('test_cases_semantic_rules.jsonl');"
    );

    expect(scanned.stringLiterals).toContain('test_cases_semantic_rules.jsonl');
  });

  it('вложенные шаблонные строки не сбивают состояние разбора', () => {
    const scanned = scanText(
      'const x = `outer ${`http://host`} ${readFileSync(\n  "test_cases_semantic_rules.jsonl"\n)}`;'
    );

    expect(scanned.stringLiterals).toContain('test_cases_semantic_rules.jsonl');
  });

  it('строка с // внутри не обрезается', () => {
    expect(scanText("const url = 'http://example.com/x';").stringLiterals).toContain(
      'http://example.com/x'
    );
  });
});

describe('scanSourceReferences — отказы', () => {
  it('падает на отсутствующем файле — тихий пустой скан скрыл бы утечку', () => {
    expect(() => scanSourceReferences(path.join(root, 'nope.ts'))).toThrow(/nope/);
  });
});
