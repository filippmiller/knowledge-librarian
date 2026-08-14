import { describe, expect, it } from 'vitest';
import { checkClaimGrounding } from '../claim-grounding';
import {
  buildEvidenceCitations,
  mergeCitations,
  type SynthesisEvidence,
} from '../enhanced-answering-engine';

/**
 * translation-ijy. Замер на 16 вопросах живого прода: 76% названных сумм не
 * подтверждались ни одной показанной цитатой. Причина не в ранжировании —
 * источник цены (строка прайса, Q&A-пара) в пул цитат не попадал вообще,
 * цитаты строились только из правил. Подтверждающая цитата не могла появиться
 * в принципе.
 *
 * Здесь проверяется обратная связь: цитата ВЫВОДИТСЯ из заземления, поэтому
 * подтверждает по построению, а не по совпадению темы.
 */

/** Реальная форма строки прайса из `buildTariffContext`. */
const TARIFF_LINE = '· Нотариальное заверение перевода — 1 100 руб. за документ';
/** Реальная форма правила, которое раньше показывали вместо неё. */
const OFFTOPIC_RULE = '[R-2007] Заверение: 150 рублей за один документ плюс стоимость НЗ.';

function evidence(): SynthesisEvidence[] {
  return [
    { text: TARIFF_LINE, citation: { documentTitle: 'Прайс', quote: TARIFF_LINE, relevanceScore: 1 } },
    {
      text: OFFTOPIC_RULE,
      citation: { ruleCode: 'R-2007', documentTitle: 'Прайс на перевод', quote: OFFTOPIC_RULE, relevanceScore: 1 },
    },
  ];
}

describe('checkClaimGrounding(): провенанс', () => {
  it('говорит, КАКОЙ источник заземлил число, а не только что оно заземлено', () => {
    const verdict = checkClaimGrounding(
      'Нотариальное заверение стоит 1 100 рублей.',
      evidence().map((e) => e.text)
    );

    expect(verdict.grounded).toBe(true);
    expect(verdict.supported).toHaveLength(1);
    expect(verdict.supported[0].value).toBe('1100');
    // Индекс 0 — строка прайса. Правило про 150 рублей это число не содержит,
    // и попасть в подтверждения не может.
    expect(verdict.supported[0].sourceIndexes).toEqual([0]);
  });

  it('незаземлённое число в supported не попадает', () => {
    const verdict = checkClaimGrounding(
      'Это стоит 9 999 рублей.',
      evidence().map((e) => e.text)
    );

    expect(verdict.grounded).toBe(false);
    expect(verdict.supported).toHaveLength(0);
    expect(verdict.ungrounded[0].value).toBe('9999');
  });

  /**
   * Поисточниковый разбор убирает целый класс ложных заземлений: при склейке
   * источник, кончающийся на число, и следующий, начинающийся с единицы
   * измерения, давали несуществующее утверждение. Граница источника теперь
   * непреодолима физически, а не за счёт удачного разделителя.
   */
  it('число из одного источника и единица из другого не склеиваются в утверждение', () => {
    const verdict = checkClaimGrounding('Это стоит 5000 рублей.', ['Всего позиций: 5000', 'рублей за штуку']);

    expect(verdict.grounded).toBe(false);
    expect(verdict.ungrounded[0].value).toBe('5000');
  });
});

describe('buildEvidenceCitations()', () => {
  it('цитирует строку прайса, из которой взята сумма, а не постороннее правило', () => {
    const ev = evidence();
    const verdict = checkClaimGrounding(
      'Нотариальное заверение стоит 1 100 рублей.',
      ev.map((e) => e.text)
    );

    const citations = buildEvidenceCitations(verdict.supported, ev);

    expect(citations).toHaveLength(1);
    expect(citations[0].quote).toBe(TARIFF_LINE);
    // Главное свойство: в показанной цитате названная сумма ДЕЙСТВИТЕЛЬНО есть.
    expect(citations[0].quote).toContain('1 100');
  });

  it('одно и то же число из нескольких источников даёт одну цитату', () => {
    const ev: SynthesisEvidence[] = [
      { text: 'Заверение — 1 100 руб.', citation: { quote: 'Заверение — 1 100 руб.', relevanceScore: 1 } },
      { text: 'Ещё раз: 1 100 руб.', citation: { quote: 'Ещё раз: 1 100 руб.', relevanceScore: 1 } },
    ];
    const verdict = checkClaimGrounding('Стоит 1 100 рублей.', ev.map((e) => e.text));

    expect(buildEvidenceCitations(verdict.supported, ev)).toHaveLength(1);
  });

  /**
   * Находка ревью PR #87. Цитата бралась как первые 200 символов источника, а в
   * длинном чанке или теле правила подтверждающее число часто стоит дальше —
   * и цитата снова не содержала того, что подтверждает. То есть разрыв
   * атрибуции сохранялся ровно там, где источник длинный.
   */
  it('число за пределом обрезки всё равно попадает в цитату', () => {
    const longSource =
      'Общие положения о порядке оказания услуг бюро переводов. '.repeat(12) +
      'Нотариальное заверение перевода — 1 100 руб. за документ. ' +
      'Дальнейшие разделы прайса к вопросу не относятся. '.repeat(12);
    const ev: SynthesisEvidence[] = [
      {
        text: longSource,
        citation: { documentTitle: 'Прайс', quote: longSource.slice(0, 200), relevanceScore: 1 },
      },
    ];
    // Предусловие: число действительно лежит за пределом обрезки. Без этой
    // проверки тест прошёл бы и на старом поведении, ничего не проверив.
    expect(longSource.indexOf('1 100')).toBeGreaterThan(200);

    const verdict = checkClaimGrounding('Заверение стоит 1 100 рублей.', ev.map((e) => e.text));
    const citations = buildEvidenceCitations(verdict.supported, ev);

    expect(citations[0].quote).toContain('1 100');
    expect(citations[0].quote.length).toBeLessThanOrEqual(206); // 200 + многоточия
  });

  it('короткий источник цитируется целиком, без многоточий', () => {
    const ev = evidence();
    const verdict = checkClaimGrounding('Стоит 1 100 рублей.', ev.map((e) => e.text));

    expect(buildEvidenceCitations(verdict.supported, ev)[0].quote).toBe(TARIFF_LINE);
  });

  it('ответ без чисел подтверждать нечем — цитат-подтверждений нет', () => {
    const ev = evidence();
    const verdict = checkClaimGrounding('Оригинал привозить не нужно.', ev.map((e) => e.text));

    expect(buildEvidenceCitations(verdict.supported, ev)).toEqual([]);
  });
});

describe('mergeCitations()', () => {
  const evidenceCitation = { documentTitle: 'Прайс', quote: TARIFF_LINE, relevanceScore: 1 };
  const rule = (code: string) => ({
    ruleCode: code,
    documentTitle: 'Док',
    quote: `тело ${code}`,
    relevanceScore: 0.5,
  });

  it('подтверждение идёт первым — пользователь читает его раньше тематики', () => {
    const merged = mergeCitations([evidenceCitation], [rule('R-1'), rule('R-2')]);

    expect(merged[0].quote).toBe(TARIFF_LINE);
    expect(merged).toHaveLength(3);
  });

  it('тематические правила не выбрасываются: у ответа без чисел они единственные', () => {
    const merged = mergeCitations([], [rule('R-1'), rule('R-2')]);

    expect(merged.map((c) => c.ruleCode)).toEqual(['R-1', 'R-2']);
  });

  it('одна и та же цитата из обоих списков не дублируется', () => {
    const same = { ruleCode: 'R-1', documentTitle: 'Док', quote: 'тело R-1', relevanceScore: 1 };
    const merged = mergeCitations([same], [rule('R-1'), rule('R-2')]);

    expect(merged).toHaveLength(2);
    expect(merged.map((c) => c.ruleCode)).toEqual(['R-1', 'R-2']);
  });

  it('список не растёт без предела', () => {
    const merged = mergeCitations(
      [evidenceCitation],
      ['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6'].map(rule)
    );

    expect(merged).toHaveLength(5);
    // Предел режет ХВОСТ, а не подтверждение: оно осталось первым.
    expect(merged[0].quote).toBe(TARIFF_LINE);
  });
});
