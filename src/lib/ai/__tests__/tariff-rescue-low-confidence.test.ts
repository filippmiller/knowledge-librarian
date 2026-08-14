import { describe, expect, it } from 'vitest';
import { shouldAttemptTariffRescue } from '../enhanced-answering-engine';

/**
 * translation-92x. Замер на живом проде (2026-08-14): вопросы вроде «сколько
 * стоит нотариальная копия одной страницы» падали в confidenceLevel='low' —
 * этот признак считается ДО того, как прайс вообще загружен, и не знает, что
 * точный ответ есть. Дальше политика доставки блокирует автоответ на ЛЮБОМ
 * 'low' независимо от содержания ответа, и клиент получал заготовку «уточню у
 * коллеги», хотя цена в прайсе была одна и однозначная.
 *
 * Решение владельца (осознанный выбор между двумя вариантами с разным
 * прод-эффектом): узкое расширение, не трогающее сам расчёт уверенности —
 * `low` тоже пробует прямой ответ из прайса, но ТОЛЬКО через уже строгий
 * `lookupTariffForQuestion` (однозначное совпадение с одной услугой).
 */
describe('shouldAttemptTariffRescue()', () => {
  it('insufficient — как и раньше, пробуем прайс', () => {
    expect(shouldAttemptTariffRescue('insufficient', false)).toBe(true);
  });

  it('low — теперь тоже пробуем прайс (новое поведение)', () => {
    expect(shouldAttemptTariffRescue('low', false)).toBe(true);
  });

  it('medium — НЕ пробуем: обычный синтез уже достаточно уверен', () => {
    expect(shouldAttemptTariffRescue('medium', false)).toBe(false);
  });

  it('high — НЕ пробуем: не за чем обходить обычный синтез', () => {
    expect(shouldAttemptTariffRescue('high', false)).toBe(false);
  });

  it('сильный QA-матч блокирует прайс-путь даже при low/insufficient', () => {
    // hasStrongQaMatch физически не может встретиться вместе с 'low' в самом
    // движке (см. расчёт confidenceLevel выше), но функция сама по себе
    // обязана не полагаться на это — предохранитель должен работать и в
    // отрыве от вызывающего кода.
    expect(shouldAttemptTariffRescue('low', true)).toBe(false);
    expect(shouldAttemptTariffRescue('insufficient', true)).toBe(false);
  });
});
