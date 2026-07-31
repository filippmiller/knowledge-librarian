/**
 * Проверки записи тарифа — без базы и без сети.
 *
 * Форма и маршрут проверяют одним и тем же модулем `src/lib/tariffs/validation.ts`,
 * поэтому проверять его можно чистыми вызовами: не нужен ни поднятый сервер, ни
 * прод-база, и набор кейсов стоит секунду.
 *
 * Что здесь ловится и почему это важно именно для цен:
 *   — сумма ≤ 0 и «сумма у процентной строки»: цена, собранная не из тех полей,
 *     печатается уверенно и неотличима от верной;
 *   — обязательные признаки клетки матрицы: клетка без языка или без срока
 *     попадёт в отбор по чужому запросу;
 *   — границы периода: перевёрнутый период делает строку вечно недействующей;
 *   — пересечение периодов: два активных тарифа на одну услугу — это ровно
 *     дефект «20 000 против 22 000», ради которого сетка и заводилась.
 *
 * Запуск: npx tsx scripts/verify-tariff-api.ts
 */
import {
  findOverlappingTariffs,
  periodsOverlap,
  tariffIdentityKey,
  validateTariffInput,
  type ExistingTariff,
  type TariffIdentity,
} from '@/lib/tariffs/validation';

let checks = 0;
let failures = 0;

function ok(name: string, detail = ''): void {
  checks += 1;
  console.log(`  OK   ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  checks += 1;
  failures += 1;
  console.log(`  FAIL ${name} — ${detail}`);
}

/** Тариф обязан пройти проверку. */
function expectValid(name: string, input: unknown): void {
  const result = validateTariffInput(input);
  if (result.ok) ok(name);
  else fail(name, `отклонён: ${result.issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`);
}

/** Тариф обязан быть отклонён, и именно по названному полю. */
function expectInvalid(name: string, input: unknown, field: string): void {
  const result = validateTariffInput(input);
  if (result.ok) {
    fail(name, 'принят, хотя должен быть отклонён');
    return;
  }
  const hit = result.issues.find((i) => i.field === field);
  if (hit) ok(name, hit.message);
  else
    fail(
      name,
      `отклонён не по тому полю: ожидалось «${field}», получено ${result.issues
        .map((i) => i.field)
        .join(', ')}`
    );
}

/** Плоская услуга прайса: апостиль МЮ СПб. */
const FLAT = {
  section: 'APOSTILLE_SPB',
  serviceName: 'Апостиль Министерство юстиции СПб',
  authority: 'МЮ СПб',
  termText: '1 – 1,5 недели',
  amountKind: 'FIXED',
  amount: 5000,
  unit: 'DOCUMENT',
  priceText: '5000 руб./док.',
  effectiveFrom: '2026-01-01',
  audience: 'CLIENT_SAFE',
};

/** Клетка языковой матрицы: английский, 1 категория, стандарт, без заверения. */
const CELL = {
  section: 'TRANSLATION',
  serviceName: 'Перевод с английского, 1 категория, СТАНДАРТ',
  amountKind: 'FIXED',
  amount: 440,
  unit: 'CONDITIONAL_PAGE',
  priceText: '440 руб. за 1 у.с.',
  effectiveFrom: '2026-01-01',
  audience: 'CLIENT_SAFE',
  language: 'АНГЛИЙСКИЙ',
  complexityCategory: 1,
  direction: 'FROM_FOREIGN',
  turnaround: 'STANDARD',
};

function main(): void {
  console.log('РАЗБОР И ПРОВЕРКА ПОЛЕЙ');

  expectValid('плоская услуга прайса проходит', FLAT);
  expectValid('клетка матрицы проходит', CELL);
  expectValid('сумма строкой с запятой и пробелом', {
    ...FLAT,
    amount: '27 500,50',
    priceText: '27 500,50 руб./док.',
  });
  expectValid('процентная строка проходит', {
    ...FLAT,
    amountKind: 'PERCENT_OF_BASE',
    amount: null,
    percent: 70,
    percentBase: 'стоимости 1 у.с.',
    unit: 'PERCENT',
    priceText: '70% от стоимости 1 у.с.',
  });
  expectValid('составная цена: разовый тариф плюс поштучная', {
    ...FLAT,
    baseFeeAmount: 1000,
    amount: 260,
    unit: 'PAGE',
    priceText: '1000 руб. тариф + 260 руб./стр',
  });
  expectValid('период с датой окончания', { ...FLAT, effectiveTo: '2026-12-31' });

  expectInvalid('не объект', 'просто строка', '_');
  expectInvalid('неизвестный раздел', { ...FLAT, section: 'APOSTILLE_KAZAN' }, 'section');
  expectInvalid('пустое название услуги', { ...FLAT, serviceName: '   ' }, 'serviceName');
  expectInvalid('пустая цена текстом', { ...FLAT, priceText: '' }, 'priceText');
  expectInvalid('отрицательная сумма', { ...FLAT, amount: -100 }, 'amount');
  expectInvalid('нулевая сумма', { ...FLAT, amount: 0 }, 'amount');
  expectInvalid('сумма не число', { ...FLAT, amount: 'дорого' }, 'amount');
  expectInvalid('сумма на порядок больше прайса', { ...FLAT, amount: 55_000_000 }, 'amount');
  expectInvalid('фиксированная цена без суммы', { ...FLAT, amount: null }, 'amount');
  expectInvalid('отрицательный разовый тариф', { ...FLAT, baseFeeAmount: -1 }, 'baseFeeAmount');
  expectInvalid(
    'процентная строка без процента',
    { ...FLAT, amountKind: 'PERCENT_SURCHARGE', amount: null, priceText: '+10% от стоимости' },
    'percent'
  );
  expectInvalid(
    'у процентной строки заполнена сумма',
    {
      ...FLAT,
      amountKind: 'PERCENT_SURCHARGE',
      percent: 10,
      percentBase: 'стоимости',
      amount: 5000,
      priceText: '+10% от стоимости',
    },
    'amount'
  );
  expectInvalid(
    'процент от базы без указания базы',
    { ...FLAT, amountKind: 'PERCENT_OF_BASE', amount: null, percent: 70, priceText: '70%' },
    'percentBase'
  );
  expectInvalid('отрицательный процент', {
    ...FLAT,
    amountKind: 'PERCENT_OF_BASE',
    amount: null,
    percent: -5,
    percentBase: 'стоимости',
    priceText: '-5%',
  }, 'percent');
  expectInvalid(
    'процент у обычной строки',
    { ...FLAT, percent: 10 },
    'percent'
  );

  expectInvalid('клетка матрицы без языка', { ...CELL, language: null }, 'language');
  expectInvalid(
    'клетка матрицы без категории',
    { ...CELL, complexityCategory: null },
    'complexityCategory'
  );
  expectInvalid(
    'категория вне 1–3',
    { ...CELL, complexityCategory: 4 },
    'complexityCategory'
  );
  expectInvalid('клетка матрицы без направления', { ...CELL, direction: null }, 'direction');
  expectInvalid('клетка матрицы без срока', { ...CELL, turnaround: null }, 'turnaround');
  expectInvalid('неизвестный срок', { ...CELL, turnaround: 'ЗАВТРА' }, 'turnaround');
  expectInvalid('признаки матрицы у плоской услуги', { ...FLAT, language: 'АНГЛИЙСКИЙ' }, 'section');

  expectInvalid('без даты начала действия', { ...FLAT, effectiveFrom: null }, 'effectiveFrom');
  expectInvalid('дата начала не дата', { ...FLAT, effectiveFrom: 'с нового года' }, 'effectiveFrom');
  expectInvalid(
    'конец периода раньше начала',
    { ...FLAT, effectiveTo: '2025-12-31' },
    'effectiveTo'
  );
  expectInvalid(
    'конец периода равен началу',
    { ...FLAT, effectiveTo: '2026-01-01' },
    'effectiveTo'
  );
  expectInvalid('валюта из четырёх букв', { ...FLAT, currency: 'RUBL' }, 'currency');
  expectInvalid('неизвестная единица', { ...FLAT, unit: 'ЛИСТ' }, 'unit');
  expectInvalid('неизвестный контур', { ...FLAT, audience: 'PARTNERS' }, 'audience');

  // Умолчания: контур обязан быть внутренним, если его не назвали. Ошибка
  // разметки должна приводить к молчанию, а не к утечке внутренней цены.
  const defaults = validateTariffInput({ ...FLAT, audience: undefined });
  if (defaults.ok && defaults.value.audience === 'INTERNAL_ONLY') {
    ok('контур по умолчанию — внутренний');
  } else {
    fail('контур по умолчанию — внутренний', defaults.ok ? defaults.value.audience : 'отклонён');
  }

  const trimmed = validateTariffInput({ ...FLAT, serviceName: '  Апостиль  ', authority: '   ' });
  if (trimmed.ok && trimmed.value.serviceName === 'Апостиль' && trimmed.value.authority === null) {
    ok('пробелы срезаются, пустая строка становится null');
  } else {
    fail('пробелы срезаются, пустая строка становится null', 'разбор не совпал с ожиданием');
  }

  console.log('');
  console.log('ПЕРЕСЕЧЕНИЕ ПЕРИОДОВ');

  const jan = (day: number) => new Date(Date.UTC(2026, 0, day));
  const feb = (day: number) => new Date(Date.UTC(2026, 1, day));

  function period(from: Date, to: Date | null) {
    return { effectiveFrom: from, effectiveTo: to };
  }

  if (periodsOverlap(period(jan(1), null), period(feb(1), null))) {
    ok('две бессрочные редакции пересекаются');
  } else {
    fail('две бессрочные редакции пересекаются', 'пересечение не найдено');
  }
  if (!periodsOverlap(period(jan(1), jan(31)), period(feb(1), null))) {
    ok('периоды встык не пересекаются');
  } else {
    fail('периоды встык не пересекаются', 'найдено ложное пересечение');
  }
  if (periodsOverlap(period(jan(1), feb(10)), period(feb(1), null))) {
    ok('периоды с общим куском пересекаются');
  } else {
    fail('периоды с общим куском пересекаются', 'пересечение не найдено');
  }

  const base: TariffIdentity = {
    section: 'VITAL_RECORDS_URGENT',
    audience: 'CLIENT_SAFE',
    serviceName: 'Срочное истребование свидетельства ЗАГС',
    authority: 'ЗАГС СПб',
    termText: '3 р.д.',
    language: null,
    complexityCategory: null,
    direction: null,
    turnaround: null,
    includesNotary: false,
  };

  const existing: ExistingTariff[] = [
    { ...base, id: 'old', priceText: '20 000 руб./док.', effectiveFrom: jan(1), effectiveTo: null, isActive: true },
  ];

  const candidate = { ...base, effectiveFrom: feb(1), effectiveTo: null };

  const conflicts = findOverlappingTariffs(candidate, existing);
  if (conflicts.length === 1 && conflicts[0].id === 'old') {
    ok('вторая цена на ту же услугу поймана', '«20 000 против 22 000»');
  } else {
    fail('вторая цена на ту же услугу поймана', `найдено ${conflicts.length}`);
  }

  const closed: ExistingTariff[] = [{ ...existing[0], effectiveTo: jan(31) }];
  if (findOverlappingTariffs(candidate, closed).length === 0) {
    ok('закрытая предыдущая редакция конфликтом не считается');
  } else {
    fail('закрытая предыдущая редакция конфликтом не считается', 'найдено ложное пересечение');
  }

  const archived: ExistingTariff[] = [{ ...existing[0], isActive: false }];
  if (findOverlappingTariffs(candidate, archived).length === 0) {
    ok('архивная строка конфликтом не считается');
  } else {
    fail('архивная строка конфликтом не считается', 'найдено ложное пересечение');
  }

  if (findOverlappingTariffs(candidate, existing, { excludeId: 'old' }).length === 0) {
    ok('строка не конфликтует сама с собой при правке');
  } else {
    fail('строка не конфликтует сама с собой при правке', 'найдено ложное пересечение');
  }

  if (findOverlappingTariffs({ ...candidate, audience: 'INTERNAL_ONLY' }, existing).length === 0) {
    ok('внутренняя и клиентская цена одной услуги живут вместе');
  } else {
    fail('внутренняя и клиентская цена одной услуги живут вместе', 'найдено ложное пересечение');
  }

  if (findOverlappingTariffs({ ...candidate, termText: '1 р.д.' }, existing).length === 0) {
    ok('другой срок — другая услуга');
  } else {
    fail('другой срок — другая услуга', 'найдено ложное пересечение');
  }

  const cellIdentity = {
    section: 'TRANSLATION' as const,
    audience: 'CLIENT_SAFE' as const,
    serviceName: 'Перевод с английского, 1 категория, СТАНДАРТ',
    authority: null,
    termText: null,
    language: 'АНГЛИЙСКИЙ',
    complexityCategory: 1,
    direction: 'FROM_FOREIGN' as const,
    turnaround: 'STANDARD' as const,
    includesNotary: false,
  };
  const cellExisting: ExistingTariff[] = [
    {
      ...cellIdentity,
      id: 'cell-old',
      priceText: '440 руб. за 1 у.с.',
      effectiveFrom: jan(1),
      effectiveTo: null,
      isActive: true,
    },
  ];

  // Язык в прайсе именительным падежом, в форме его пишут как угодно: клетка
  // одна и та же, и конфликт обязан найтись по основе слова.
  const sameCell = {
    ...cellIdentity,
    language: 'английского',
    serviceName: 'Перевод, английский, 1 кат.',
    effectiveFrom: feb(1),
    effectiveTo: null,
  };
  if (findOverlappingTariffs(sameCell, cellExisting).length === 1) {
    ok('та же клетка матрицы опознана несмотря на падеж и другое название');
  } else {
    fail('та же клетка матрицы опознана несмотря на падеж и другое название', 'конфликт не найден');
  }

  if (findOverlappingTariffs({ ...sameCell, language: 'НЕМЕЦКИЙ' }, cellExisting).length === 0) {
    ok('другой язык — другая клетка');
  } else {
    fail('другой язык — другая клетка', 'найдено ложное пересечение');
  }

  if (findOverlappingTariffs({ ...sameCell, includesNotary: true }, cellExisting).length === 0) {
    ok('колонка «вкл. НЗ» — отдельная клетка');
  } else {
    fail('колонка «вкл. НЗ» — отдельная клетка', 'найдено ложное пересечение');
  }

  if (findOverlappingTariffs({ ...sameCell, isActive: false }, cellExisting).length === 0) {
    ok('строка, заводимая сразу в архив, ни с чем не конфликтует');
  } else {
    fail('строка, заводимая сразу в архив, ни с чем не конфликтует', 'найдено ложное пересечение');
  }

  if (tariffIdentityKey(cellIdentity) === tariffIdentityKey({ ...cellIdentity, serviceName: 'иначе названная строка' })) {
    ok('ключ клетки матрицы не зависит от написания названия');
  } else {
    fail('ключ клетки матрицы не зависит от написания названия', 'ключи разошлись');
  }

  console.log('');
  console.log(`ИТОГ: проверок ${checks}, провалов ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

main();
