import { describe, expect, it, vi } from 'vitest';
import { synthesizeFromSelectedUnits } from '../synthesize';
import type { EvidencePack } from '../evidence-pack';
import type { AnswerGenerator, SynthesisPrompt } from '../synthesize';

/**
 * План §3 PR H — правила synthesis-пути:
 * «генератор получает ТОЛЬКО selected reviewed units — не сырые чанки, не
 * результаты поиска до applicability-фильтрации»; «`general_ai` fallback в H
 * ОТКЛЮЧЁН, не «не приветствуется»»; «`answerSource: 'knowledge_base'`
 * выставляется НОВЫМ orchestration-путём осознанно, а не наследуется случайно
 * от старого движка».
 */

const pack = (overrides: Partial<EvidencePack> = {}): EvidencePack => ({
  items: [
    {
      unitId: 'u1',
      kind: 'PROCEDURE_STEP',
      statement: 'Не дольше 15 секунд подряд.',
      citation: { anchor: 'a1', quote: 'не дольше 15 секунд' },
      numericConstraint: { factKey: 'max_seconds', value: 15, unit: 'seconds' },
    },
  ],
  numericFacts: [{ factKey: 'max_seconds', value: 15, unit: 'seconds' }],
  ...overrides,
});

const generator = (
  result: { text: string; citedUnitIds: string[] } = {
    text: 'Не дольше 15 секунд.',
    citedUnitIds: ['u1'],
  }
): AnswerGenerator => vi.fn(async () => result);

describe('synthesizeFromSelectedUnits — что видит генератор', () => {
  it('передаёт генератору ровно выбранные units', async () => {
    const generate = generator();

    await synthesizeFromSelectedUnits(pack(), 'Сколько можно чесать?', generate);

    const prompt = (generate as unknown as { mock: { calls: [SynthesisPrompt][] } }).mock.calls[0][0];
    expect(prompt.evidence.map((e) => e.unitId)).toEqual(['u1']);
    expect(prompt.evidence[0].statement).toContain('15 секунд');
  });

  it('передаёт вопрос пользователя', async () => {
    const generate = generator();

    await synthesizeFromSelectedUnits(pack(), 'Сколько можно чесать?', generate);

    const prompt = (generate as unknown as { mock: { calls: [SynthesisPrompt][] } }).mock.calls[0][0];
    expect(prompt.question).toBe('Сколько можно чесать?');
  });

  it('передаёт source anchors — цитаты строятся из них, не из номера кандидата', async () => {
    const generate = generator();

    await synthesizeFromSelectedUnits(pack(), 'в?', generate);

    const prompt = (generate as unknown as { mock: { calls: [SynthesisPrompt][] } }).mock.calls[0][0];
    expect(prompt.evidence[0].citation.anchor).toBe('a1');
  });

  it('передаёт числовые ограничения — генератору не из чего выдумать другое число', async () => {
    const generate = generator();

    await synthesizeFromSelectedUnits(pack(), 'в?', generate);

    const prompt = (generate as unknown as { mock: { calls: [SynthesisPrompt][] } }).mock.calls[0][0];
    expect(prompt.evidence[0].numericConstraint).toEqual({
      factKey: 'max_seconds',
      value: 15,
      unit: 'seconds',
    });
  });
});

describe('synthesizeFromSelectedUnits — answerSource выставляется осознанно', () => {
  it('всегда knowledge_base — путь H не наследует источник от старого движка', async () => {
    const draft = await synthesizeFromSelectedUnits(pack(), 'в?', generator());

    expect(draft.answerSource).toBe('knowledge_base');
  });

  it('генератор НЕ может назначить answerSource сам', async () => {
    const sneaky = vi.fn(async () => ({
      text: 'Ответ.',
      citedUnitIds: ['u1'],
      answerSource: 'general_ai',
    })) as unknown as AnswerGenerator;

    const draft = await synthesizeFromSelectedUnits(pack(), 'в?', sneaky);

    expect(draft.answerSource).toBe('knowledge_base');
  });
});

describe('synthesizeFromSelectedUnits — fallback отключён', () => {
  it('ошибка генератора пробрасывается, а не подменяется общим ответом', async () => {
    const failing: AnswerGenerator = async () => {
      throw new Error('модель недоступна');
    };

    await expect(synthesizeFromSelectedUnits(pack(), 'в?', failing)).rejects.toThrow(
      /модель недоступна/
    );
  });

  it('пустой текст от генератора — ошибка, а не пустой ответ', async () => {
    const empty = generator({ text: '   ', citedUnitIds: ['u1'] });

    await expect(synthesizeFromSelectedUnits(pack(), 'в?', empty)).rejects.toThrow();
  });

  it('падает на пустом evidence pack — синтезировать не из чего', async () => {
    await expect(
      synthesizeFromSelectedUnits(pack({ items: [], numericFacts: [] }), 'в?', generator())
    ).rejects.toThrow();
  });
});

describe('synthesizeFromSelectedUnits — цитаты не санируются', () => {
  it('несуществующая цитата доходит до верификатора, а не вычищается молча', async () => {
    const hallucinating = generator({ text: 'Ответ.', citedUnitIds: ['u1', 'u404'] });

    const draft = await synthesizeFromSelectedUnits(pack(), 'в?', hallucinating);

    expect(draft.citedUnitIds).toEqual(['u1', 'u404']);
  });
});
