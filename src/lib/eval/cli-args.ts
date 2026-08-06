/**
 * Разбор аргументов прогона корпуса.
 *
 * Отдельным модулем, потому что это часть контракта шлюза, а не оформление:
 * опечатка в флаге режима не имеет права молча оставить gate в baseline, то
 * есть выключить проверку и отрапортовать успех. Здесь это закреплено тестом.
 */

import { RUN_MODES, type RunMode } from './disposition';

export interface RunOptions {
  mode: RunMode;
  /** Прогнать один кейс по стабильному id. `null` — весь корпус. */
  idFilter: string | null;
  /** Куда положить снимок. `null` — путь по умолчанию, считает вызывающий. */
  outPath: string | null;
}

export const USAGE = `--mode=${RUN_MODES.join('|')} --id=<caseId> --out=<путь>`;

/**
 * Режим по умолчанию — `baseline`: незаданный режим означает «сними снимок»,
 * а не «проверь молча». Шлюз включается только явным словом, поэтому забытый
 * флаг не может выглядеть как пройденная проверка.
 */
export function parseRunArgs(argv: readonly string[]): RunOptions {
  const options: RunOptions = { mode: 'baseline', idFilter: null, outPath: null };

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (!(RUN_MODES as readonly string[]).includes(value)) {
        throw new Error(`Неизвестный режим "${value}". Допустимо: ${RUN_MODES.join(' | ')}.`);
      }
      options.mode = value as RunMode;
    } else if (arg.startsWith('--id=')) {
      const value = arg.slice('--id='.length);
      if (value.length === 0) throw new Error('--id= задан пустым.');
      options.idFilter = value;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (value.length === 0) throw new Error('--out= задан пустым.');
      options.outPath = value;
    } else {
      throw new Error(`Неизвестный аргумент "${arg}". Допустимо: ${USAGE}.`);
    }
  }

  return options;
}
