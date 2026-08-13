/**
 * Реестры контролируемых словарей (Задача 2.2) и разрешение синонимов.
 *
 * `service`/`documentType`/страны/языки/города/партнёры сегодня сверяются
 * только по ФОРМЕ (см. `conceptIdSchema` в `facets.ts`) — синтаксически верный,
 * но выдуманный код молча проходит и попадает в KB. Этот модуль закрывает
 * пробел тем же способом, что и `scenario`: единственный источник истины
 * (`src/lib/knowledge/scenarios.ts` → `SCENARIOS`), сверка по значению, а не
 * только по форме.
 *
 * `ConceptAlias` — ВСПОМОГАТЕЛЬНАЯ нормализация уже известных синонимов
 * («перевод» → `translation`, «английский» → `en`), а не замена semantic
 * retrieval. Если успех системы зависит от того, что каждая возможная
 * перефразировка внесена сюда заранее — это словарь ключевых слов, а не
 * понимание смысла (план, §0.4 / R4). Синонимы контрольных вопросов из
 * `scripts/fixtures/semantic-rule-extraction-test-pack/` НЕ должны появляться
 * здесь: G/H проверяют именно то, что распознаётся БЕЗ такой подсказки.
 */

/** Одна запись словаря: канонический id, читаемая метка и известные синонимы. */
export interface ConceptDefinition {
  readonly id: string;
  readonly label: string;
  /** Известные способы назвать то же самое: другим словом, регистром,
   *  языком. НЕ используется для расширения ФОРМАТНОЙ проверки — `id` сам
   *  обязан пройти схему facet-а. */
  readonly aliases?: readonly string[];
}

/** Словарь — карта `id -> ConceptDefinition`, ключ повторяет `.id` записи. */
export type ConceptVocabulary = Readonly<Record<string, ConceptDefinition>>;

export function isKnownConcept(vocabulary: ConceptVocabulary, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(vocabulary, id);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Проверка на этапе загрузки — сверяется в тестах и при старте, не по одной
 * записи за раз в рантайме. Ловит три случая, каждый из которых уже был
 * реальным дефектом где-то в этом контракте:
 * - ключ карты разошёлся с `id` записи (тихий дрейф при переименовании);
 * - один алиас закреплён за двумя концептами (неоднозначность, а не «первый
 *   попавшийся» в `resolveConceptAlias`);
 * - метка или алиас пусты ПО СМЫСЛУ (одни пробелы) — «well-formed but
 *   semantically empty», тот же класс, что `nonBlankString` закрывает для
 *   facet-значений.
 */
export function assertVocabularyConsistency(vocabulary: ConceptVocabulary, vocabularyName: string): void {
  // Собран ДО основного прохода: алиас, совпадающий с чужим id, — та же
  // неоднозначность, что алиас на двух концептах (см. ниже) — `resolveConceptAlias`
  // обязан всегда предпочесть точный id, а не молча выбрать один из двух
  // одинаково правдоподобных ответов.
  const ids = new Set(Object.values(vocabulary).map((entry) => entry.id.toLowerCase()));
  const aliasOwners = new Map<string, string>();

  for (const [key, entry] of Object.entries(vocabulary)) {
    if (key !== entry.id) {
      throw new Error(
        `Словарь "${vocabularyName}": ключ "${key}" не совпадает с id записи "${entry.id}"`
      );
    }
    if (isBlank(entry.label)) {
      throw new Error(`Словарь "${vocabularyName}": у концепта "${entry.id}" пустая метка`);
    }
    for (const alias of entry.aliases ?? []) {
      if (isBlank(alias)) {
        throw new Error(`Словарь "${vocabularyName}": у концепта "${entry.id}" пустой алиас`);
      }
      const normalized = alias.trim().toLowerCase();
      if (normalized !== entry.id.toLowerCase() && ids.has(normalized)) {
        throw new Error(
          `Словарь "${vocabularyName}": алиас "${alias}" концепта "${entry.id}" совпадает с id другого концепта`
        );
      }
      const owner = aliasOwners.get(normalized);
      if (owner !== undefined && owner !== entry.id) {
        throw new Error(
          `Словарь "${vocabularyName}": алиас "${alias}" закреплён и за "${owner}", и за "${entry.id}"`
        );
      }
      aliasOwners.set(normalized, entry.id);
    }
  }
}

/**
 * Нормализует сырой текст (регистр, края) и ищет либо точное совпадение с
 * каноническим id, либо с одним из объявленных алиасов. Возвращает
 * канонический id или `undefined`, если текст не опознан НИКАК — вызывающий
 * код обязан явно решить, что делать с неопознанным значением (человек,
 * clarification), а не получить тихий no-op.
 */
export function resolveConceptAlias(
  vocabulary: ConceptVocabulary,
  rawText: string
): string | undefined {
  const normalized = rawText.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  // Two passes, not one: a canonical id ALWAYS wins over another concept's
  // alias, even if that concept happens to be defined earlier in the object
  // (Object.values order is insertion order — letting a single pass decide
  // by iteration order made the result depend on where in the file each
  // entry sits, not on which match is more authoritative).
  // `assertVocabularyConsistency` already forbids an alias that collides
  // with a DIFFERENT concept's id, so a real vocabulary never lets both
  // passes disagree — this is defense in depth, not the primary guarantee.
  for (const entry of Object.values(vocabulary)) {
    if (entry.id.toLowerCase() === normalized) return entry.id;
  }
  for (const entry of Object.values(vocabulary)) {
    if (entry.aliases?.some((alias) => alias.trim().toLowerCase() === normalized)) {
      return entry.id;
    }
  }
  return undefined;
}
