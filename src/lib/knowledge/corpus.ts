import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';

/**
 * Изоляция корпусов знаний (translation-0lr, находка совета мудрецов).
 *
 * ЗАЧЕМ. До этого поля данные не разделялись ничем: в `prisma/schema.prisma` не
 * было ни `tenantId`, ни `organizationId`, ни аналога. Фильтр по доменам в
 * движке ответов выключен намеренно (`enhanced-answering-engine.ts`,
 * `[], // domains disabled` — четыре домена покрывали 161 правило из 163),
 * а единственный работающий разделитель, дерево сценариев, знает только про
 * апостиль и переводы. Всё остальное падает в открытый поиск ПО ВСЕЙ БАЗЕ.
 *
 * Практическое следствие, ради которого поле и заводится: залив документ чужой
 * области (ремонт велосипедов, инструкция АЭС, что угодно) в ту же базу, клиент
 * бюро переводов получал бы ответ, собранный из чужого документа. Это состояние
 * ДО этого модуля, а не гипотетический риск.
 *
 * ПОЧЕМУ СТРОКА С ДЕФОЛТОМ, А НЕ ТАБЛИЦА `Corpus`. Дефолт делает КАЖДУЮ
 * существующую запись — и каждый существующий путь записи, которых в проекте
 * несколько десятков — автоматически корректной без единой правки: всё, что
 * лежит и пишется сегодня, принадлежит корпусу бюро. Отдельная таблица с
 * внешними ключами потребовала бы тронуть все эти пути разом, то есть внести
 * риск в живой прод ради свойства, которое сегодня никем не используется.
 * Таблица появится, когда появится второй корпус и понадобятся его настройки.
 */

/** Корпус, которому принадлежит всё, что уже лежит в базе. */
export const DEFAULT_CORPUS_ID = 'aurora';

/**
 * Корпус текущего запроса.
 *
 * Пока источник один — дефолт: второго корпуса в проде нет, и придумывать ему
 * способ доставки (заголовок? поддомен? поле сессии?) раньше, чем появится сам
 * корпус, значило бы закрепить непроверенное решение. Важно здесь не то, откуда
 * берётся значение, а то, что ЧИТАЮЩИЙ КОД ОБЯЗАН его спросить: фильтр,
 * который некому обойти, — и есть изоляция.
 */
export function resolveCorpusId(explicit?: string | null): string {
  const value = explicit?.trim();
  return value && value.length > 0 ? value : DEFAULT_CORPUS_ID;
}

/** Предикат Prisma. Отдельной функцией, чтобы места чтения не расходились в
 *  том, как именно они фильтруют. */
export function corpusWhere(corpusId: string): { corpusId: string } {
  return { corpusId };
}

/**
 * Клауза для СЫРОГО SQL — векторный и полнотекстовый поиск по `DocChunk` идут
 * через `$queryRaw`, и Prisma-предикат туда не подставить.
 *
 * Значение экранируется, а не склеивается: `corpusId` приходит из запроса, и
 * склейка строкой сделала бы изоляцию корпусов местом SQL-инъекции — то есть
 * ровно противоположным тому, ради чего она вводится.
 */
export function corpusFilterSql(alias: string, corpusId: string): Prisma.Sql {
  return Prisma.sql`AND ${Prisma.raw(`"${alias}"."corpusId"`)} = ${corpusId}`;
}

/**
 * Проставляет корпус документу и его производным знаниям.
 *
 * Дословно повторяет контракт `setDocumentAudience` (`audience.ts`): Document —
 * источник истины, копии в трёх таблицах — денормализация ради одного
 * предиката без join, всё одной транзакцией. Расходиться этим двум функциям
 * нельзя: они обслуживают один и тот же класс поля.
 */
export async function setDocumentCorpus(
  documentId: string,
  corpusId: string
): Promise<{ rules: number; qaPairs: number; chunks: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.document.update({ where: { id: documentId }, data: { corpusId } });
    const rules = await tx.rule.updateMany({ where: { documentId }, data: { corpusId } });
    const qaPairs = await tx.qAPair.updateMany({ where: { documentId }, data: { corpusId } });
    const chunks = await tx.docChunk.updateMany({ where: { documentId }, data: { corpusId } });
    return { rules: rules.count, qaPairs: qaPairs.count, chunks: chunks.count };
  });
}
