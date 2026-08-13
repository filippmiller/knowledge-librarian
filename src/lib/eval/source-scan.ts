/**
 * Сканер ссылок на основе AST TypeScript (Beads translation-yz9 / PR H).
 *
 * Обслуживает ворота изоляции oracle (план §0.3). Ценность ворот целиком в
 * том, что их нельзя обмануть, поэтому разбор ведёт настоящий компилятор:
 *
 * - комментарии в AST не попадают вовсе, поэтому запрет, записанный В
 *   КОММЕНТАРИИ («не добавлять сюда синонимы контрольных вопросов»), больше не
 *   считается нарушением — ручной лексер на этом ошибался;
 * - regex-литералы и вложенные шаблонные строки разбирает парсер, а не наша
 *   посимвольная машина состояний, которая на них рассинхронизировалась и
 *   МОЛЧА прятала последующий запрещённый доступ;
 * - динамический `import()` и `require()` видны наравне со статическими —
 *   иначе обход графа через них был бы бесплатной утечкой.
 *
 * Остаточное ограничение, закрываемое на другом уровне: путь, собранный
 * вычислением (`['test','cases'].join('_')`), в литералах не виден. Против
 * этого класса работает не сканер, а инвертированное правило ворот — движку
 * запрещён импорт из `@/lib/eval` целиком, а не только «плохих» строк.
 */

import fs from 'node:fs';
import ts from 'typescript';

export interface ScannedReferences {
  /** Specifier-ы модулей: статические, `export ... from`, `import()`, `require()`. */
  readonly moduleSpecifiers: readonly string[];
  /** Все строковые литералы и текстовые части шаблонных строк. Без комментариев. */
  readonly stringLiterals: readonly string[];
}

const isRequireCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'require';

/**
 * Разбирает файл и собирает все ссылки. Отсутствующий файл — исключение:
 * молча пустой результат означал бы «нарушений не найдено» на опечатке в пути,
 * то есть ворота, которые всегда зелены.
 */
export function scanSourceReferences(filePath: string): ScannedReferences {
  if (!fs.existsSync(filePath)) {
    throw new Error(`scanSourceReferences: файл не найден — ${filePath}`);
  }

  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const moduleSpecifiers: string[] = [];
  const stringLiterals: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) {
        moduleSpecifiers.push(first.text);
      }
    }

    if (isRequireCall(node)) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) {
        moduleSpecifiers.push(first.text);
      }
    }

    // `import x = require('...')` (ImportEqualsDeclaration/ExternalModuleReference,
    // preflight B, translation-5lf) — синтаксически НЕ ImportDeclaration и НЕ
    // CallExpression-require, отдельная ветка грамматики TS. Без явной
    // обработки specifier всё равно попал бы в общий `stringLiterals` через
    // рекурсию ниже, но НЕ в `moduleSpecifiers` — а именно `moduleSpecifiers`
    // проверяет ворота "продуктовый код не импортирует lib/eval"
    // (oracle-isolation.test.ts), то есть этот синтаксис обходил бы ворота
    // молча, оставаясь незамеченным именно там, где он опасен.
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      moduleSpecifiers.push(node.moduleReference.expression.text);
    }

    if (ts.isStringLiteralLike(node)) {
      stringLiterals.push(node.text);
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      stringLiterals.push(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return { moduleSpecifiers, stringLiterals };
}
