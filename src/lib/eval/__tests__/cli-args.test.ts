import { describe, expect, it } from 'vitest';
import { parseRunArgs } from '../cli-args';

describe('parseRunArgs', () => {
  it('без аргументов — baseline, весь корпус', () => {
    expect(parseRunArgs([])).toEqual({ mode: 'baseline', idFilter: null, outPath: null });
  });

  it('разбирает все флаги', () => {
    expect(parseRunArgs(['--mode=gate', '--id=case-7', '--out=/tmp/snap.json'])).toEqual({
      mode: 'gate',
      idFilter: 'case-7',
      outPath: '/tmp/snap.json',
    });
  });

  it('неизвестный режим — ошибка, а не тихий baseline', () => {
    expect(() => parseRunArgs(['--mode=lost'])).toThrow(/Неизвестный режим "lost"/);
  });

  it('флаг через пробел не проглатывается молча', () => {
    // `--mode gate` иначе оставил бы шлюз выключенным и отрапортовал успех.
    expect(() => parseRunArgs(['--mode', 'gate'])).toThrow(/Неизвестный аргумент/);
  });

  it('чужой флаг из другого харнесса отвергается', () => {
    expect(() => parseRunArgs(['--fail-on=lost'])).toThrow(/Неизвестный аргумент "--fail-on=lost"/);
  });

  it('пустые значения отвергаются', () => {
    expect(() => parseRunArgs(['--id='])).toThrow(/--id=/);
    expect(() => parseRunArgs(['--out='])).toThrow(/--out=/);
  });
});
