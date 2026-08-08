import { describe, expect, it } from 'vitest';
import { segmentSourceRules } from '../source-rule-segmentation';

/**
 * План §0.3 [R4a]: `sourceRuleId` определяется из нумерации/структуры исходного
 * DOCX — НЕ генерируется LLM. Сегментация живёт на стороне раннера, поэтому
 * номер правила физически не может попасть в `retrievalText` движка.
 */

const PREAMBLE = [
  'УЧЕБНАЯ ИНСТРУКЦИЯ № 04',
  'Порядок безопасного устранения зуда в ягодичной области',
  'Назначение: вымышленный документ для проверки семантического поиска.',
].join('\n\n');

describe('segmentSourceRules', () => {
  it('извлекает номер, заголовок и тело правила', () => {
    const rules = segmentSourceRules('1. Уединение и доступ. Перейти в закрытое место.');

    expect(rules).toEqual([
      {
        sourceRuleId: 1,
        title: 'Уединение и доступ',
        text: '1. Уединение и доступ. Перейти в закрытое место.',
        paragraphIndex: 0,
      },
    ]);
  });

  it('игнорирует преамбулу — «ИНСТРУКЦИЯ № 04» не является правилом 4', () => {
    const rules = segmentSourceRules(`${PREAMBLE}\n\n1. Первое. Тело.\n\n2. Второе. Тело.`);

    expect(rules.map((r) => r.sourceRuleId)).toEqual([1, 2]);
    expect(rules[0].paragraphIndex).toBe(3);
  });

  it('сохраняет исходный индекс абзаца — основа стабильного anchor', () => {
    const rules = segmentSourceRules('Преамбула.\n\n1. Первое. Тело.');

    expect(rules[0].paragraphIndex).toBe(1);
  });

  it('падает на разрыве в нумерации — молча пропущенное правило ломает oracle', () => {
    expect(() => segmentSourceRules('1. Первое. Тело.\n\n3. Третье. Тело.')).toThrow(/2/);
  });

  it('падает на дубле номера', () => {
    expect(() => segmentSourceRules('1. Первое. Тело.\n\n1. Снова первое. Тело.')).toThrow(
      /дубл|1/i
    );
  });

  it('падает, если нумерация начинается не с единицы', () => {
    expect(() => segmentSourceRules('2. Второе. Тело.')).toThrow();
  });

  it('не находит правил в тексте без нумерации — пустой результат, не исключение', () => {
    expect(segmentSourceRules(PREAMBLE)).toEqual([]);
  });
});

describe('segmentSourceRules на реальном учебном DOCX', () => {
  it('даёт ровно 10 правил с непрерывной нумерацией 1–10', async () => {
    const { loadSourceRulesFromDocx } = await import('../source-rule-segmentation');
    const rules = await loadSourceRulesFromDocx();

    expect(rules).toHaveLength(10);
    expect(rules.map((r) => r.sourceRuleId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('заголовки правил совпадают со структурой документа', async () => {
    const { loadSourceRulesFromDocx } = await import('../source-rule-segmentation');
    const rules = await loadSourceRulesFromDocx();

    expect(rules.map((r) => r.title)).toEqual([
      'Уединение и доступ',
      'Чистота рук',
      'Допустимая техника',
      'Сила и продолжительность',
      'Ситуация вне дома',
      'Признаки немедленной остановки',
      'Возвращающийся зуд',
      'Завершение',
      'Помощь другого человека',
      'Ограниченная подвижность',
    ]);
  });

  it('правило 4 несёт все три числовых ограничения — совместное покрытие Q04', async () => {
    const { loadSourceRulesFromDocx } = await import('../source-rule-segmentation');
    const rule4 = (await loadSourceRulesFromDocx()).find((r) => r.sourceRuleId === 4);

    expect(rule4?.text).toContain('15 секунд');
    expect(rule4?.text).toContain('30 секунд');
    expect(rule4?.text).toContain('трёх');
  });
});
