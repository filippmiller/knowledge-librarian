import { describe, expect, it } from 'vitest';

import { parseArgs } from '../run-aurora-fixture';
import { retrievalContractProbe } from '../../src/lib/knowledge/semantic-retrieval';

/**
 * `--rerank-pool-size=N` — ДИАГНОСТИЧЕСКОЕ переопределение кардинальности пула,
 * уходящего в реранкер (`fused.slice(0, N)` в `retrieveUnits`).
 *
 * Флаг существует ради атрибуции провалов стадии retrieval: прогон с N, равным
 * размеру корпуса, показывает ПОТОЛОК того, что вообще способна купить любая
 * политика пула. Поэтому цена ошибки здесь не "неудобство", а испорченный
 * замер — отсюда набор гарантий ниже.
 *
 * Отдельный файл, а не расширение `run-aurora-fixture-dependency-graph-skip
 * .test.ts`: тот покрывает другой измерительный override и живёт своей жизнью.
 */

const REQUIRED = [
  '--mode=e2e',
  '--out=C:/tmp/aurora-rerank-pool-size-test',
  '--max-cost-usd=0.50',
  '--max-paid-calls=7',
];

describe('parseArgs — --rerank-pool-size', () => {
  it('отсутствие флага оставляет поле НЕОПРЕДЕЛЁННЫМ, а не подставляет число', () => {
    // Именно undefined, а не DEFAULT_RERANK_POOL_SIZE: дефолт обязан
    // разрешаться внутри retrieveUnits, иначе CLI начнёт молча фиксировать
    // сегодняшнюю константу и переживёт её изменение.
    expect(parseArgs(REQUIRED).rerankPoolSize).toBeUndefined();
  });

  it('заданный флаг доходит до CliArgs числом', () => {
    expect(parseArgs([...REQUIRED, '--rerank-pool-size=49']).rerankPoolSize).toBe(49);
  });

  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    it(`отвергает "${bad}" ДО начала прогона`, () => {
      // Валидация обязана падать в parseArgs, а не в retrieveUnits: к моменту
      // вызова retrieveUnits прогон уже потратил деньги на query-frame.
      expect(() => parseArgs([...REQUIRED, `--rerank-pool-size=${bad}`])).toThrow(
        /--rerank-pool-size/
      );
    });
  }

  it('0 отвергается, хотя retrieveUnits трактует его как легальный пустой пул', () => {
    // Библиотечный контракт шире CLI-контракта намеренно: платный прогон,
    // запросивший пустой пул, ответил бы на вопрос, которого никто не задавал.
    expect(() => parseArgs([...REQUIRED, '--rerank-pool-size=0'])).toThrow();
  });
});

describe('--rerank-pool-size — отпечаток не может соврать', () => {
  it('прогон с переопределением и прогон на дефолте дают РАЗНЫЕ отпечатки', () => {
    const overridden = parseArgs([...REQUIRED, '--rerank-pool-size=49']).rerankPoolSize;
    const asDefault = parseArgs(REQUIRED).rerankPoolSize;
    expect(JSON.stringify(retrievalContractProbe(overridden))).not.toBe(
      JSON.stringify(retrievalContractProbe(asDefault))
    );
  });

  it('дефолтный прогон даёт отпечаток, идентичный вызову пробы без аргумента', () => {
    // Гарантия обратной совместимости: замеры, снятые ДО появления флага,
    // остаются сопоставимы с сегодняшними дефолтными прогонами.
    expect(JSON.stringify(retrievalContractProbe(parseArgs(REQUIRED).rerankPoolSize))).toBe(
      JSON.stringify(retrievalContractProbe())
    );
  });
});
