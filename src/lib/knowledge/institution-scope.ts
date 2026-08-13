/**
 * Учреждения и регионы, которые нельзя смешивать в одном ответе.
 *
 * Retrieval пускает чанки с `scenarioKey=null` в любой сценарий
 * (`IS NULL OR IN ancestors`). Из-за этого график ЗАГС ЛО попадал
 * в ответ про КЗАГС СПб и в ответ про Минюст: у чанка ЛО ключа нет,
 * а слова «загс/апостиль» совпадают. Промпт это не лечит.
 *
 * Аудит 2026-08-13 (живой прогон на вопросе «Как поставить апостиль в КЗАГС
 * СПб?») нашёл четыре дефекта первой версии, все закрыты здесь тестами:
 * 1. «Управление ЗАГС» без привязки к ЛО давало `zags_lo` — а это БЫВШЕЕ
 *    название самого питерского комитета, и чанк с его адресом вырезался.
 * 2. «Ленинградский проспект/шоссе/вокзал» (Москва) давали `zags_lo`.
 * 3. «оптиковолоконный» давал `minjust` (детектор улицы Оптиков).
 * 4. Районные ЗАГСы Ленобласти (Гатчина, Выборг, ...) не давали `zags_lo`
 *    вовсе — безымянный ЛО-чанк проходил в ответ про СПб.
 */

export type InstitutionScope = 'zags_spb' | 'zags_lo' | 'minjust' | 'mvd';

// Города/райцентры Ленобласти, встречающиеся в графиках районных ЗАГСов.
// Стемы без окончаний, чтобы ловить «Гатчинский отдел», «в Выборге».
// «Луга»/«Сланцы» намеренно НЕ включены: совпадают с обычными словами
// (луга́ как множественное от «луг», сланцы-обувь) — цена ложного
// срабатывания выше пропуска одного райцентра.
const LO_TOWNS =
  'гатчин|выборг|всеволожск|тосненск|тосно|кингисепп|волосов|тихвин|кириш|приозерск|лодейн|бокситогорск|подпорож|волховск|кировск[а-яё]*\\s+район|сертолово|мурино|кудрово';

const DETECTORS: Array<{ id: InstitutionScope; re: RegExp }> = [
  {
    id: 'zags_spb',
    re: /кзагс|комитет[а-яё]*\s+по\s+делам\s+загс|фурштатск|загс[а-яё]*\s+(?:спб|санкт|петербург)|(?:спб|санкт[\s-]*петербург)[а-яё]*\s+загс/giu,
  },
  {
    id: 'zags_lo',
    // «ленинградск» с продолжением «проспект/шоссе/вокзал/улица» — московские
    // топонимы, не область. [а-яё]* стоит ВНУТРИ lookahead'а, а не перед ним:
    // с внешним [а-яё]* движок откатом укоротил бы хвост слова («ленинградски»
    // + «й проспект»), lookahead перестал бы видеть « проспект» — и ложное
    // совпадение вернулось бы.
    re: new RegExp(
      String.raw`загс[а-яё]*\s+(?:ло|лен)(?:[^а-яё]|$|инградск|област)|управлен[а-яё]*\s+загс[а-яё]*\s+(?:ло|лен|по\s+ленинградск)|ленинградск(?![а-яё]*\s+(?:проспект|шоссе|вокзал|улиц))|ленобласт|(?:^|[^а-яё])ло\s+загс|${LO_TOWNS}`,
      'giu'
    ),
  },
  {
    id: 'minjust',
    // «оптиков» только как отдельное слово (улица Оптиков — адрес управления
    // Минюста): «оптиковолоконный» и подобные не считаются.
    re: /минюст|мин\s*юст|(?:^|[^а-яё])мю(?:[^а-яё]|$)|министерств[а-яё]*\s+юстиц|оптиков(?:[^а-яё]|$)/giu,
  },
  {
    id: 'mvd',
    re: /(?:^|[^а-яё])мвд(?:[^а-яё]|$)|несудим|гувм/giu,
  },
];

const SCENARIO_TO_SCOPE: Record<string, InstitutionScope> = {
  'apostille.zags.spb': 'zags_spb',
  'apostille.zags.lo': 'zags_lo',
  'apostille.min_justice': 'minjust',
};

/** Сколько раз каждый детектор сработал в тексте (0 не включается).
 *  Скоуп из scenarioKey добавляет один хит: явная разметка — не слабее
 *  одного текстового упоминания. */
export function countInstitutionScopeHits(
  text: string,
  scenarioKey?: string | null
): Map<InstitutionScope, number> {
  const hits = new Map<InstitutionScope, number>();
  for (const detector of DETECTORS) {
    detector.re.lastIndex = 0;
    const count = [...text.matchAll(detector.re)].length;
    if (count > 0) hits.set(detector.id, count);
  }
  const mapped = scenarioKey ? SCENARIO_TO_SCOPE[scenarioKey] : undefined;
  if (mapped) hits.set(mapped, (hits.get(mapped) ?? 0) + 1);
  return hits;
}

export function detectInstitutionScopes(
  text: string,
  scenarioKey?: string | null
): Set<InstitutionScope> {
  return new Set(countInstitutionScopeHits(text, scenarioKey).keys());
}

/**
 * Конфликтует ли улика с учреждением вопроса.
 *
 * Чанк, где есть и КЗАГС, и ЗАГС ЛО, раньше оставляли — модель брала оттуда
 * график ЛО и приписывала его СПб. Поэтому чужое учреждение в чанке — повод
 * для дропа, ДАЖЕ если спрошенное учреждение в чанке тоже есть и упомянуто
 * чаще («доминирование» здесь не работает: чанк "КЗАГС, Фурштатская 52 +
 * график ЛО" — ровно исходный баг, и КЗАГС в нём упомянут дважды).
 *
 * Единственное исключение — чанк с ТРЕМЯ и более учреждениями, среди которых
 * спрошенное: это маршрутизация/обзор («диплом — Минюст, СОР — КЗАГС,
 * несудимость — МВД»), а не смешанный график двух ЗАГСов. Аудит 2026-08-13
 * показал, что такие чанки помогают ответу, а не портят его.
 */
export function evidenceConflictsWithQuestion(
  questionScopes: ReadonlySet<InstitutionScope>,
  evidenceHits: ReadonlyMap<InstitutionScope, number>
): boolean {
  if (questionScopes.size === 0 || evidenceHits.size === 0) return false;

  const foreign = [...evidenceHits.keys()].filter((scope) => !questionScopes.has(scope));
  if (foreign.length === 0) return false;

  const mentionsQuestionScope = [...evidenceHits.keys()].some((scope) =>
    questionScopes.has(scope)
  );
  if (mentionsQuestionScope && evidenceHits.size >= 3) return false;

  return true;
}

export function filterCrossInstitutionEvidence<T>(
  question: string,
  scenarioKey: string | undefined,
  items: readonly T[],
  textOf: (item: T) => string,
  scenarioKeyOf?: (item: T) => string | null | undefined
): T[] {
  const questionScopes = detectInstitutionScopes(question, scenarioKey);
  if (questionScopes.size === 0) return [...items];
  return items.filter((item) => {
    const evidenceHits = countInstitutionScopeHits(textOf(item), scenarioKeyOf?.(item));
    return !evidenceConflictsWithQuestion(questionScopes, evidenceHits);
  });
}
