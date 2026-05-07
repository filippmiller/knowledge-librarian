import assert from 'node:assert/strict';

const BASE = process.env.APP_BASE_URL || 'https://avrora-library-production.up.railway.app';
const ADMIN_USER = process.env.ADMIN_USER || 'filipp';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD environment variable is required');
}

const AUTH = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64');

const TESTS = [
  {
    question: 'как заполнить лид сделку и бланк заказа?',
    minConfidence: 0.45,
    requiredDoc: /Чек_лист_заполнение_Лида|Шпаргалка/i,
    answerMustInclude: [/лид/i, /сделк/i],
  },
  {
    question: 'какие образовательные документы можно апостилировать?',
    minConfidence: 0.55,
    requiredDoc: /шпаргалка про апостили|образовательные документы/i,
    answerMustInclude: [/диплом/i, /аттестат/i],
  },
  {
    question: 'что делать если нужна консульская легализация?',
    minConfidence: 0.55,
    requiredDoc: /ИНСТРУКЦИЯ КЛ общее/i,
    answerMustInclude: [/МЮ/i, /МИД/i, /консульств/i],
  },
  {
    question: 'для каких стран требуется консульская легализация?',
    minConfidence: 0.55,
    requiredDoc: /Список_стран_для_которых_ТРЕБУЕТСЯ_КЛ/i,
    answerMustInclude: [/Ангола/i, /Афганистан/i, /Бангладеш/i],
  },
  {
    question: 'нужна ли консульская легализация для Анголы?',
    minConfidence: 0.45,
    requiredDoc: /Список_стран_для_которых_ТРЕБУЕТСЯ_КЛ/i,
    answerMustInclude: [/да/i, /Ангол/i],
  },
];

function sourceTitles(response) {
  return [
    response.primarySource?.documentTitle,
    ...(response.supplementarySources ?? []).map((source) => source.documentTitle),
    ...(response.citations ?? []).map((citation) => citation.documentTitle),
  ].filter(Boolean);
}

async function ask(question) {
  const response = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: AUTH,
    },
    body: JSON.stringify({ question, includeDebug: true }),
  });

  assert.equal(response.status, 200, `${question}: expected HTTP 200`);
  return response.json();
}

for (const test of TESTS) {
  const result = await ask(test.question);
  const docs = sourceTitles(result);

  assert.equal(result.needsClarification, false, `${test.question}: should not ask clarification`);
  assert.ok(
    result.confidence >= test.minConfidence,
    `${test.question}: confidence ${result.confidence} is below ${test.minConfidence}`
  );
  assert.ok(
    docs.some((doc) => test.requiredDoc.test(doc)),
    `${test.question}: missing required source. Sources: ${docs.join(' | ')}`
  );
  for (const pattern of test.answerMustInclude) {
    assert.match(result.answer, pattern, `${test.question}: answer missing ${pattern}`);
  }

  console.log(`ok: ${test.question}`);
}
