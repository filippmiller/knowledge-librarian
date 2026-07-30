/**
 * Проверка заземления рискованных утверждений.
 *
 * Владелец определил ошибку как противоречие фактам, и самые дорогие
 * противоречия — числовые: цена, срок, процент предоплаты. Модель синтезирует
 * ответ из контекста, но ничто не мешает ей сложить два тарифа, перенести цифру
 * из соседней строки прайса или назвать срок, которого в источниках не было.
 * Уверенность движка тут не помогает: это максимум семантической близости
 * найденных чанков, а не вероятность того, что число верное.
 *
 * Поэтому проверка чисто механическая: каждое число, поданное как деньги, срок
 * или процент, обязано встречаться в источниках В ТОМ ЖЕ КАЧЕСТВЕ. Сравнение по
 * паре (тип, значение), а не по голому числу: иначе «срок 5 дней» считался бы
 * подтверждённым строкой «у нас 5 офисов», а «70 рублей» — строкой «предоплата
 * 70%». Это не гипотетика: числа 3, 5, 10 и 70 встречаются в базе в обеих ролях.
 *
 * Это НЕ проверка правильности: цитата может быть из устаревшего прайса. Это
 * проверка происхождения — она отсекает выдуманное и посчитанное, оставляя
 * ошибки разметки другим контролям.
 */

export type ClaimKind = 'money' | 'duration' | 'percent';

/** Число вместе с ролью, которая делает его утверждением о деньгах или сроке. */
export interface RiskyClaim {
  /** Нормализованное значение: «27 500» и «27500» — одно и то же. */
  value: string;
  /** Единица сравнения: rub, day, week, month, hour, minute, percent. */
  unit: string;
  kind: ClaimKind;
  /** Фрагмент вокруг числа — для операторского разбора. */
  context: string;
}

/**
 * Пробелы внутри числа бывают обычные, неразрывные и тонкие: «35 400», «35 400»,
 * «35 400». Для сравнения все они убираются, иначе источник и ответ не совпадут
 * из-за типографики. Запятая приводится к точке: «1,5 месяца» и «1.5 месяца».
 */
const SPACES = /[\s   ]/g;

function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(SPACES, '').replace(/,/g, '.');
  // Хвостовые нули после точки не меняют величину, но ломают сравнение строк:
  // «1.50» из ответа против «1,5» из источника.
  return cleaned.includes('.') ? cleaned.replace(/0+$/, '').replace(/\.$/, '') : cleaned;
}

const NUM = String.raw`\d[\d\s   ]*(?:[.,]\d+)?`;
const DASH = String.raw`\s*(?:-|–|—|…|\.\.\.)\s*`;

/**
 * Множитель между числом и единицей: «12 тыс. рублей», «1,5 млн руб.».
 * Без него разговорная форма цены не распознавалась как утверждение о деньгах
 * вовсе — выдуманная сумма проходила проверку с нулём найденных утверждений.
 */
const MAGNITUDE = String.raw`(?:\s*(тыс\.?|тысяч[а-яё]*|млн\.?|миллион[а-яё]*))?`;

const MAGNITUDE_FACTOR: Array<{ test: RegExp; factor: number }> = [
  { test: /^(?:млн|миллион)/iu, factor: 1_000_000 },
  { test: /^(?:тыс|тысяч)/iu, factor: 1_000 },
];

/** «12 тыс.» и «12000» — одна сумма, сравнивать их надо как одну. */
function applyMagnitude(value: string, magnitude: string | undefined): string {
  if (!magnitude) return value;
  const entry = MAGNITUDE_FACTOR.find((m) => m.test.test(magnitude.trim()));
  if (!entry) return value;
  const scaled = Number(value) * entry.factor;
  return Number.isFinite(scaled) ? normalizeNumber(String(scaled)) : value;
}

/**
 * Единицы измерения по отдельности, а не одним классом «срок».
 *
 * Классом было слишком грубо: строка «офис в 5 минутах от метро» заземляла
 * ответ «срок выполнения 5 дней». Минуты ходьбы и дни исполнения — разные
 * величины, и совпадение числа между ними ничего не подтверждает. Поэтому
 * сравнение идёт по паре (единица, значение).
 *
 * Сокращения из инструкций компании обязательны: «3 р.д.», «45 Р.Д.», «14 к.д.».
 * Без них ответ «3 рабочих дня» не находил бы источник «3 р.д.», и годный ответ
 * уходил бы человеку.
 */
interface UnitSpec {
  /** Ключ сравнения. Совпадать обязаны и он, и значение. */
  unit: string;
  kind: ClaimKind;
  pattern: string;
}

const UNITS: UnitSpec[] = [
  // `р` и `р.` (рубль) отделяются от `р.д.` (рабочий день) просмотром вперёд.
  // Точка после «р» необязательна: «1100 р» — живая форма записи, и без неё
  // выдуманная сумма не распознавалась как утверждение о деньгах вовсе.
  {
    unit: 'rub',
    kind: 'money',
    // `(?![\s.]*д)` обязан стоять ДО проверки на букву: при необязательной точке
    // движок откатывается на позицию перед ней, и просмотр «\s*д» промахивается
    // мимо «д» в «3 р.д.» — рабочий день засчитывался как три рубля.
    pattern: String.raw`(?:₽|руб\.?|рублей|рубля|р\.?(?![\s.]*д)(?![а-яё]))`,
  },
  {
    unit: 'day',
    kind: 'duration',
    pattern: String.raw`(?:(?:календарн[а-яё]*|рабоч[а-яё]*)\s+)?(?:дн[еяй][а-яё]*|день|р\.\s*д\.?|к\.\s*д\.?|р\/д)`,
  },
  { unit: 'week', kind: 'duration', pattern: String.raw`(?:календарн[а-яё]*\s+)?недел[а-яё]+` },
  { unit: 'month', kind: 'duration', pattern: String.raw`(?:календарн[а-яё]*\s+)?месяц[а-яё]*` },
  { unit: 'hour', kind: 'duration', pattern: String.raw`час[а-яё]*` },
  { unit: 'minute', kind: 'duration', pattern: String.raw`минут[а-яё]*` },
  { unit: 'percent', kind: 'percent', pattern: String.raw`(?:%|процент[а-яё]*)` },
];

function singlePattern(spec: UnitSpec): RegExp {
  return new RegExp(String.raw`(${NUM})${MAGNITUDE}\s*${spec.pattern}`, 'giu');
}

/**
 * Диапазон обязан давать ОБЕ границы. «Предоплата 60–70%» против источника,
 * где есть только «70%», — это выдуманная нижняя граница, то есть обещание
 * клиенту меньшей суммы, чем компания берёт. Прежняя версия ловила только
 * верхнюю границу, потому что первая половина диапазона не примыкает к единице.
 */
function rangePattern(spec: UnitSpec): RegExp {
  return new RegExp(String.raw`(${NUM})${DASH}(${NUM})${MAGNITUDE}\s*${spec.pattern}`, 'giu');
}

function add(
  into: Map<string, RiskyClaim>,
  spec: UnitSpec,
  rawValue: string,
  text: string,
  at: number,
  matchLength: number,
  magnitude?: string
): void {
  const value = applyMagnitude(normalizeNumber(rawValue), magnitude);
  if (!value || Number(value) === 0) return;
  const key = claimKey(spec.unit, value);
  if (into.has(key)) return;
  const from = Math.max(0, at - 40);
  into.set(key, {
    value,
    unit: spec.unit,
    kind: spec.kind,
    context: text.slice(from, Math.min(text.length, at + matchLength + 40)).replace(/\s+/g, ' ').trim(),
  });
}

function claimKey(unit: string, value: string): string {
  return `${unit}:${value}`;
}

export function extractRiskyClaims(text: string): RiskyClaim[] {
  const found = new Map<string, RiskyClaim>();

  for (const spec of UNITS) {
    // Сначала диапазоны: они дают обе границы. Одиночный проход после этого
    // добавит только то, чего диапазоны не покрыли, — дубли отсекает ключ.
    // Множитель у диапазона общий и стоит после второй границы: «10–12 тыс.
    // рублей» означает и 10 000, и 12 000.
    const range = rangePattern(spec);
    let m: RegExpExecArray | null;
    while ((m = range.exec(text)) !== null) {
      add(found, spec, m[1], text, m.index, m[0].length, m[3]);
      add(found, spec, m[2], text, m.index, m[0].length, m[3]);
    }

    const single = singlePattern(spec);
    while ((m = single.exec(text)) !== null) {
      add(found, spec, m[1], text, m.index, m[0].length, m[2]);
    }
  }

  return [...found.values()];
}

export interface GroundingVerdict {
  grounded: boolean;
  /** Утверждения, которых нет в источниках в том же качестве. */
  ungrounded: RiskyClaim[];
  /** Сколько рискованных утверждений всего — оценка «числовитости» ответа. */
  total: number;
}

/**
 * Проверить ответ против источников.
 *
 * `sources` — это ПОЛНЫЙ контекст синтеза (те же строки, что ушли в промпт), а
 * не массив citations: тот обрезан до 200 символов на правило, и цена за
 * обрезом дала бы ложную тревогу. Передавать сюда чанки, которые до промпта не
 * дошли, тоже нельзя: число из отброшенного чанка модель не видела, и признать
 * его источником — значит заземлить выдумку.
 */
export function checkClaimGrounding(answer: string, sources: string[]): GroundingVerdict {
  const claims = extractRiskyClaims(answer);
  if (claims.length === 0) return { grounded: true, ungrounded: [], total: 0 };

  // Разделитель обязан содержать НЕ-пробельный символ. Между числом и единицей
  // в шаблонах стоит `\s*`, а перевод строки — тоже пробел: при склейке через
  // «\n» источник, кончающийся на «1100», и следующий, начинающийся с «рублей»,
  // давали несуществующее утверждение «1100 рублей» и заземляли выдумку.
  const sourceClaims = extractRiskyClaims(sources.join(' ¦ '));
  const allowed = new Set(sourceClaims.map((c) => claimKey(c.unit, c.value)));

  const ungrounded = claims.filter((c) => !allowed.has(claimKey(c.unit, c.value)));
  return { grounded: ungrounded.length === 0, ungrounded, total: claims.length };
}
