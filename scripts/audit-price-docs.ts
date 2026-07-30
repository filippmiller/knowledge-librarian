/**
 * Что система видит в прайсах против того, что в них написано.
 *
 * Пайплайн читает docx через mammoth.extractRawText (src/lib/document-parser.ts:23).
 * Прайс — таблица. extractRawText таблицу расплющивает: строки и столбцы
 * превращаются в поток ячеек без связи между собой. Скрипт печатает оба вида,
 * чтобы разница была видна глазами, а не по описанию.
 */
import mammoth from 'mammoth';
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';

const FILES = process.argv.slice(2);

async function main() {
  for (const file of FILES) {
    const buffer = readFileSync(file);
    const name = basename(file).replace(/\s+/g, '_').replace(/\.docx$/i, '');

    const raw = await mammoth.extractRawText({ buffer });
    const html = await mammoth.convertToHtml({ buffer });

    writeFileSync(`${name}.raw.txt`, raw.value, 'utf8');
    writeFileSync(`${name}.html`, html.value, 'utf8');

    const tableCount = (html.value.match(/<table/g) || []).length;
    const rowCount = (html.value.match(/<tr>/g) || []).length;

    console.log(`\n===== ${basename(file)} =====`);
    console.log(`таблиц в документе: ${tableCount}, строк таблиц: ${rowCount}`);
    console.log(`длина raw-текста (то, что видит пайплайн): ${raw.value.length} символов`);
    console.log(`\n--- ПЕРВЫЕ 1500 СИМВОЛОВ RAW (взгляд системы) ---`);
    console.log(raw.value.slice(0, 1500));
    console.log(`\n--- ФРАГМЕНТ HTML (реальная структура) ---`);
    const firstTable = html.value.indexOf('<table');
    console.log(html.value.slice(firstTable, firstTable + 1200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
