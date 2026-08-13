import { describe, expect, it } from 'vitest';
import {
  detectInstitutionScopes,
  filterCrossInstitutionEvidence,
} from '@/lib/knowledge/institution-scope';

const SPB_CHUNK = {
  id: 'spb',
  content: 'КЗАГС СПб, Фурштатская 52. ЗАПИСЬ НА ПОДАЧУ НЕ ТРЕБУЕТСЯ.',
  scenarioKey: null as string | null,
};

const LO_CHUNK = {
  id: 'lo',
  content: 'Управление ЗАГС ЛО: записывают на неделю вперёд, приём во вторник и четверг.',
  scenarioKey: null as string | null,
};

const MINJUST_CHUNK = {
  id: 'mj',
  content: 'Минюст, ул. Оптиков, 35к1. Приём по предварительной записи.',
  scenarioKey: 'apostille.min_justice' as string | null,
};

describe('filterCrossInstitutionEvidence — не смешивает учреждения', () => {
  it('смешанный чанк КЗАГС+ЛО выкидывается — иначе модель берёт график ЛО', () => {
    const mixed = {
      id: 'mixed',
      content: 'КЗАГС, Фурштатская 52. В ЗАГС ЛО записывают на неделю вперёд.',
      scenarioKey: null as string | null,
    };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [mixed],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept).toEqual([]);
  });

  it('вопрос про КЗАГС СПб выкидывает чанк ЗАГС ЛО', () => {
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [SPB_CHUNK, LO_CHUNK],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['spb']);
  });

  it('вопрос про Минюст выкидывает график ЗАГС ЛО', () => {
    const kept = filterCrossInstitutionEvidence(
      'как апостилировать доверенность',
      'apostille.min_justice',
      [MINJUST_CHUNK, LO_CHUNK],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['mj']);
  });

  it('чанк без учреждения не выкидывается', () => {
    const generic = { id: 'any', content: 'Апостиль ставится по месту выдачи документа.', scenarioKey: null };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [generic, LO_CHUNK],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['any']);
  });

  it('без учреждения в вопросе фильтр молчит', () => {
    const kept = filterCrossInstitutionEvidence(
      'Нужен ли апостиль для документов в Казахстан?',
      undefined,
      [SPB_CHUNK, LO_CHUNK, MINJUST_CHUNK],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept).toHaveLength(3);
  });
});

describe('detectInstitutionScopes', () => {
  it('ключ сценария КЗАГС задаёт СПб даже без слов в тексте', () => {
    expect([...detectInstitutionScopes('апостиль свидетельства', 'apostille.zags.spb')]).toEqual([
      'zags_spb',
    ]);
  });
});

// Дефекты живого прогона из аудита 2026-08-13 — каждый случай ниже
// воспроизводился на первой версии фильтра.
describe('дефекты аудита 2026-08-13', () => {
  it('«Управление ЗАГС города» (бывшее имя питерского комитета) — НЕ ЛО: чанк с адресом Фурштатской не вырезается', () => {
    const spbWithOldName = {
      id: 'spb-old-name',
      content:
        'Комитет по делам ЗАГС СПб (бывшее Управление ЗАГС города) — Фурштатская 52, госпошлина 2500.',
      scenarioKey: null as string | null,
    };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [spbWithOldName],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['spb-old-name']);
  });

  it('«Управление ЗАГС по Ленинградской области» — по-прежнему ЛО', () => {
    expect([
      ...detectInstitutionScopes('Управление ЗАГС по Ленинградской области, график приёма'),
    ]).toContain('zags_lo');
  });

  it('«Ленинградский проспект» и «Ленинградский вокзал» (Москва) — не Ленобласть', () => {
    expect([...detectInstitutionScopes('офис на Ленинградском проспекте в Москве')]).toEqual([]);
    expect([...detectInstitutionScopes('встреча у Ленинградского вокзала')]).toEqual([]);
  });

  it('«Ленинградская область» и «Ленинградское управление» — Ленобласть', () => {
    expect([...detectInstitutionScopes('документы, выданные в Ленинградской области')]).toEqual([
      'zags_lo',
    ]);
  });

  it('«оптиковолоконный» — не Минюст, «ул. Оптиков, 35к1» — Минюст', () => {
    expect([...detectInstitutionScopes('прокладка оптиковолоконного кабеля')]).toEqual([]);
    expect([...detectInstitutionScopes('приём на ул. Оптиков, 35к1')]).toEqual(['minjust']);
  });

  it('районный ЗАГС Ленобласти без слова «область» (Гатчина, Выборг) — всё равно ЛО и вырезается из СПб-вопроса', () => {
    const districtChunk = {
      id: 'gatchina',
      content: 'Гатчинский отдел: приём документов по вторникам, запись за неделю.',
      scenarioKey: null as string | null,
    };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [SPB_CHUNK, districtChunk],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['spb']);
  });

  it('маршрутизирующий чанк с 3+ учреждениями, среди которых спрошенное, сохраняется', () => {
    const routing = {
      id: 'routing',
      content:
        'Куда подавать: диплом — в Минюст, свидетельство о рождении — в КЗАГС, справка о несудимости — в МВД.',
      scenarioKey: null as string | null,
    };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [routing],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['routing']);
  });

  it('смешанный чанк из ДВУХ учреждений режется даже при доминировании спрошенного — исходный баг с графиком ЛО', () => {
    const mixedDominant = {
      id: 'mixed-dominant',
      content:
        'КЗАГС СПб, Фурштатская 52, КЗАГС работает ежедневно. В ЗАГС Ленинградской области запись за неделю.',
      scenarioKey: null as string | null,
    };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [mixedDominant],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept).toEqual([]);
  });
});
