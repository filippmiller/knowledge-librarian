/**
 * Учреждения и регионы, которые нельзя смешивать в одном ответе.
 *
 * Retrieval пускает чанки с `scenarioKey=null` в любой сценарий
 * (`IS NULL OR IN ancestors`). Из-за этого график ЗАГС ЛО попадал
 * в ответ про КЗАГС СПб и в ответ про Минюст: у чанка ЛО ключа нет,
 * а слова «загс/апостиль» совпадают. Промпт это не лечит.
 */

export type InstitutionScope = 'zags_spb' | 'zags_lo' | 'minjust' | 'mvd';

const DETECTORS: Array<{ id: InstitutionScope; re: RegExp }> = [
  {
    id: 'zags_spb',
    re: /кзагс|комитет[а-яё]*\s+по\s+делам\s+загс|фурштатск|загс[а-яё]*\s+(?:спб|санкт|петербург)|(?:спб|санкт[\s-]*петербург)[а-яё]*\s+загс/iu,
  },
  {
    id: 'zags_lo',
    re: /загс[а-яё]*\s+(?:ло|лен)|управлен[а-яё]*\s+загс|ленинградск|ленобласт|(?:^|[^а-яё])ло\s+загс/iu,
  },
  {
    id: 'minjust',
    re: /минюст|мин\s*юст|(?:^|[^а-яё])мю(?:[^а-яё]|$)|министерств[а-яё]*\s+юстиц|оптиков/iu,
  },
  {
    id: 'mvd',
    re: /(?:^|[^а-яё])мвд(?:[^а-яё]|$)|несудим|гувм/iu,
  },
];

const SCENARIO_TO_SCOPE: Record<string, InstitutionScope> = {
  'apostille.zags.spb': 'zags_spb',
  'apostille.zags.lo': 'zags_lo',
  'apostille.min_justice': 'minjust',
};

export function detectInstitutionScopes(
  text: string,
  scenarioKey?: string | null
): Set<InstitutionScope> {
  const found = new Set<InstitutionScope>();
  const mapped = scenarioKey ? SCENARIO_TO_SCOPE[scenarioKey] : undefined;
  if (mapped) found.add(mapped);
  for (const detector of DETECTORS) {
    if (detector.re.test(text)) found.add(detector.id);
  }
  return found;
}

export function evidenceConflictsWithQuestion(
  questionScopes: ReadonlySet<InstitutionScope>,
  evidenceScopes: ReadonlySet<InstitutionScope>
): boolean {
  if (questionScopes.size === 0 || evidenceScopes.size === 0) return false;
  // Чанк, где есть и КЗАГС, и ЗАГС ЛО, раньше оставляли — модель брала
  // оттуда график ЛО и приписывала его СПб. Чужое учреждение в чанке
  // важнее частичного совпадения.
  for (const scope of evidenceScopes) {
    if (!questionScopes.has(scope)) return true;
  }
  return false;
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
    const evidenceScopes = detectInstitutionScopes(textOf(item), scenarioKeyOf?.(item));
    return !evidenceConflictsWithQuestion(questionScopes, evidenceScopes);
  });
}
