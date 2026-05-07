import assert from 'node:assert/strict';
import type { EnhancedAnswerResult } from '../src/lib/ai/enhanced-answering-engine';
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

  console.log('verify-ai-behavior: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
