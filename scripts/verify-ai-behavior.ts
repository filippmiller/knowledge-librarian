import assert from 'node:assert/strict';
import type { EnhancedAnswerResult } from '../src/lib/ai/enhanced-answering-engine';
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import {
  clearAnswerCache,
  getCachedAnswer,
  normalizeQuestionForCache,
  storeCachedAnswer,
} from '../src/lib/ai/answer-cache';
import { classifyScenario } from '../src/lib/knowledge/scenario-classifier';

async function main() {
  assert.equal(
    normalizeQuestionForCache(' Какие документы ЗАГС ты можешь мне назвать?! '),
    'какие документы загс ты можешь мне назвать'
  );

  const cacheable: EnhancedAnswerResult = {
    answer: 'Документы ЗАГС: свидетельство о рождении [R-217]',
    confidence: 0.82,
    confidenceLevel: 'high',
    needsClarification: false,
    citations: [{ ruleCode: 'R-217', quote: 'документы ЗАГС', relevanceScore: 0.8 }],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: 'какие документы ЗАГС ты можешь мне назвать',
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
  };
  clearAnswerCache();
  assert.equal(storeCachedAnswer('какие документы ЗАГС ты можешь мне назвать', cacheable), true);
  assert.equal(getCachedAnswer('какие документы загс ты можешь мне назвать')?.cacheHit, 'exact');
  assert.equal(getCachedAnswer('назови документы загс')?.cacheHit, 'similar');

  const unclear: EnhancedAnswerResult = { ...cacheable, needsClarification: true, confidenceLevel: 'insufficient' };
  assert.equal(storeCachedAnswer('где выдан документ', unclear), false);

  const zagsCatalog = await classifyScenario('какие документы ЗАГС ты можешь мне назвать');
  assert.equal(
    zagsCatalog.kind,
    'knowledge_lookup',
    'catalog-style ZAGS questions must use open retrieval instead of the apostille region clarification'
  );
  assert.match(
    zagsCatalog.reasoning,
    /справочн|каталог|спис/i,
    'catalog-style ZAGS questions must be handled by the deterministic catalog bypass, not by classifier fail-open'
  );

  const consularLegalization = await classifyScenario('для каких стран требуется консульская легализация?');
  assert.equal(
    consularLegalization.kind,
    'knowledge_lookup',
    'consular legalization materials are general knowledge docs, not apostille scenario leaves'
  );

  const leadChecklist = await classifyScenario('как заполнить лид сделку и бланк заказа?');
  assert.equal(
    leadChecklist.kind,
    'knowledge_lookup',
    'operational CRM checklist questions must use open knowledge lookup'
  );

  for (const question of [
    'Как менеджеру оформить отправку заказа Почтой России?',
    'Как взаимодействовать с Наливайко и офисом в Шушарах?',
    'Как хранить и выдавать готовые заказы клиентам?',
    'Как рассчитать машинный перевод?',
    'Что делать при приеме личных документов с молдавского языка?',
  ]) {
    const decision = await classifyScenario(question);
    assert.equal(
      decision.kind,
      'knowledge_lookup',
      `${question}: internal operational instructions must use open knowledge lookup`
    );
  }

  const apostilleReference = await classifyScenario('какие образовательные документы можно апостилировать?');
  assert.equal(
    apostilleReference.kind,
    'knowledge_lookup',
    'reference-style apostille questions should not ask for a filing authority first'
  );

  const moscowToSpbClassifier = await classifyScenario('Если документ выдан в Москве как его апостилировать в Санкт Петербурге?');
  assert.equal(
    moscowToSpbClassifier.kind,
    'out_of_scope',
    'Moscow-issued non-education documents must not be routed into СПб apostille scenarios'
  );

  const moscowToSpbAnswer = await answerQuestionEnhanced(
    'Если документ выдан в Москве как его апостилировать в Санкт Петербурге?'
  );
  assert.equal(
    moscowToSpbAnswer.answerSource,
    'deterministic_guardrail',
    'Moscow-issued document in СПб should be answered by the deterministic region guardrail'
  );
  assert.match(
    moscowToSpbAnswer.answer,
    /Никак|нельзя|Москв/i,
    'guardrail answer must clearly say that a Moscow-issued original cannot be apostilled in Санкт-Петербурге'
  );

  console.log('verify-ai-behavior: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
