/**
 * Синтез ответа из выбранных reviewed units (план §3 PR H).
 *
 * Почему синтез реализуется ЗДЕСЬ, а не переиспользуется из
 * `enhanced-answering-engine.ts`: старый движок работает поверх
 * `hybridSearch`/`DocChunk`, то есть поверх сырых чанков документа. Новый путь
 * оперирует reviewed knowledge units с identity и provenance. Это две
 * несовместимые системы, и склейка означала бы, что ворота «ответ построен на
 * найденном unit'е» проверяют не то, что мы думаем.
 *
 * Три правила плана, реализованные КОНСТРУКТИВНО, а не проверкой постфактум:
 *
 * 1. Генератор физически не может увидеть ничего, кроме `pack.items` — вход
 *    промпта собирается здесь, из pack, и другого источника у него нет.
 * 2. `answerSource` выставляется этим путём и НЕ может быть задан генератором:
 *    иначе ворота «не general_ai» проверяли бы поле, которым управляет тот же
 *    компонент, чью честность они проверяют.
 * 3. `general_ai` fallback ОТКЛЮЧЁН: сбой генератора — исключение. Ответ,
 *    полученный в обход базы знаний, по §0.3 №4 и так FAIL, поэтому подменять
 *    им ошибку — значит превращать явный сбой в тихий провал кейса.
 */

import type { EvidencePack } from './evidence-pack';
import type { DraftAnswer } from './draft-answer';
import type { KnowledgeUnitKind } from '../applicability/kinds';
import type { NumericConstraint } from '../applicability/resolution';
import type { SourceSpan } from '../applicability/extraction';

/** Ровно то, что генератору разрешено видеть. Другого входа у него нет. */
export interface SynthesisEvidence {
  readonly unitId: string;
  readonly kind: KnowledgeUnitKind;
  readonly statement: string;
  readonly citation: SourceSpan;
  readonly numericConstraint: NumericConstraint | null;
}

export interface SynthesisPrompt {
  readonly question: string;
  readonly evidence: readonly SynthesisEvidence[];
}

export interface GeneratedAnswer {
  readonly text: string;
  readonly citedUnitIds: readonly string[];
}

/**
 * Внедряемый генератор. Инъекция, а не прямой вызов модели: ворота синтеза
 * обязаны проверяться без ключей и без сети, иначе они не проверяются вовсе.
 */
export type AnswerGenerator = (prompt: SynthesisPrompt) => Promise<GeneratedAnswer>;

export async function synthesizeFromSelectedUnits(
  pack: EvidencePack,
  question: string,
  generate: AnswerGenerator
): Promise<DraftAnswer> {
  if (pack.items.length === 0) {
    throw new Error(
      'synthesizeFromSelectedUnits: evidence pack пуст — синтезировать не из чего (план §3 PR H)'
    );
  }

  const prompt: SynthesisPrompt = {
    question,
    evidence: pack.items.map((item) => ({
      unitId: item.unitId,
      kind: item.kind,
      statement: item.statement,
      citation: item.citation,
      numericConstraint: item.numericConstraint,
    })),
  };

  // Ошибка НЕ перехватывается: fallback на общий AI здесь отключён по плану.
  const generated = await generate(prompt);

  if (generated.text.trim().length === 0) {
    throw new Error(
      'synthesizeFromSelectedUnits: генератор вернул пустой текст — пустой ответ не является ответом'
    );
  }

  return {
    text: generated.text,
    // НЕ фильтруется по pack: вычистить несуществующую цитату здесь — значит
    // скрыть от `verifyAnswerClaims` ровно ту галлюцинацию, ради которой он
    // существует. Верификатор обязан увидеть то, что модель реально выдала.
    citedUnitIds: generated.citedUnitIds,
    // Выставляется здесь и только здесь — см. правило 2 в шапке.
    answerSource: 'knowledge_base',
  };
}
