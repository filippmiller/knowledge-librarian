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
  it('вопрос про КЗАГС СПб выкидывает чанк только с практикой ЛО без названия учреждения', () => {
    const loPractice = {
      id: 'lo-practice',
      content: 'Запись на подачу требуется, записывают на неделю вперёд.',
      scenarioKey: null as string | null,
    };
    const kept = filterCrossInstitutionEvidence(
      'Как поставить апостиль в КЗАГС СПб?',
      'apostille.zags.spb',
      [SPB_CHUNK, loPractice],
      (item) => item.content,
      (item) => item.scenarioKey
    );
    expect(kept.map((item) => item.id)).toEqual(['spb']);
  });

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
