// Consistency gate — post-synthesis verification.
//
// Takes a synthesized answer and the exact source chunks it was built from,
// asks a cheap LLM to extract every factual claim in the answer and mark any
// claim that is NOT supported by the source chunks. Claims flagged as
// unsupported are logged (telemetry) and can optionally be stripped from the
// answer.
//
// Why post-check instead of prompt-only: a strict prompt reduces hallucinations
// substantially but doesn't eliminate them — the model occasionally fabricates
// plausible schedules, addresses, or numbers when cross-referencing many short
// chunks. A dedicated pass that ONLY compares claims to source is structurally
// better at this than the generator itself, because:
//   1. The verifier has a narrower objective (classify, not generate).
//   2. It reads the source fresh, without the generator's "I've committed to
//      this wording" pressure.
//   3. It's cheap to run at low temperature with a simple JSON schema.

import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';

export interface ClaimCheck {
  claim: string;
  supported: boolean;
  reasoning?: string;
}

export interface ConsistencyReport {
  allSupported: boolean;
  claims: ClaimCheck[];
  unsupported: ClaimCheck[];
  /** Raw verifier response, for debugging. */
  raw?: string;
}

const VERIFIER_SYSTEM_PROMPT = `Ты — верификатор фактов. Твоя задача: проверить, что каждое конкретное утверждение в ответе подтверждено цитатами из источников.

ЧТО ПРОВЕРЯТЬ (факты-кандидаты):
- адреса, номера домов, станции метро
- телефоны, email, URL
- цены и числа (рубли, проценты, количества)
- даты, сроки, дни недели, часы работы
- имена организаций и собственные имена
- специфические требования ("не заламинирован", "на русском", "с печатью")

ЧТО НЕ ПРОВЕРЯТЬ:
- общие формулировки без конкретики ("нужно прийти лично")
- вопросы пользователю ("уточните у клиента")
- логические связки и объяснения

АЛГОРИТМ:
1. Извлеки из ОТВЕТА все факты-кандидаты.
2. Для каждого проверь: есть ли ДОСЛОВНОЕ или очевидно-производное подтверждение в ИСТОЧНИКАХ?
3. Если да — supported: true. Если факта вообще нет в источниках или он искажён — supported: false.

Вывод СТРОГО этот JSON:
{
  "claims": [
    { "claim": "точная формулировка из ответа", "supported": true|false, "reasoning": "кратко почему" }
  ]
}`;

export async function verifyAnswer(
  answer: string,
  sourceChunks: string[]
): Promise<ConsistencyReport> {
  if (!answer.trim() || sourceChunks.length === 0) {
    return { allSupported: true, claims: [], unsupported: [] };
  }

  const sourcesBlock = sourceChunks
    .map((chunk, i) => `[SOURCE ${i + 1}]\n${chunk}`)
    .join('\n\n');

  const userPrompt = `ИСТОЧНИКИ:
${sourcesBlock}

ОТВЕТ К ПРОВЕРКЕ:
${answer}

Извлеки факты-кандидаты из ОТВЕТА и проверь каждый против ИСТОЧНИКОВ. Верни JSON.`;

  let raw: string | undefined;
  try {
    raw = (await createChatCompletion({
      messages: [
        { role: 'system', content: VERIFIER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      maxTokens: 2000,
      responseFormat: 'json_object',
    })) ?? undefined;
  } catch (err) {
    console.error('[consistency-gate] verifier LLM call failed:', err);
    // Fail open: don't block answer on verifier failure.
    return { allSupported: true, claims: [], unsupported: [], raw: String(err) };
  }

  if (!raw) return { allSupported: true, claims: [], unsupported: [], raw: '(empty)' };

  let parsed: { claims?: unknown };
  try {
    parsed = JSON.parse(normalizeJsonResponse(raw));
  } catch (err) {
    console.error('[consistency-gate] failed to parse verifier output:', err, 'raw:', raw.slice(0, 300));
    return { allSupported: true, claims: [], unsupported: [], raw };
  }

  if (!Array.isArray(parsed.claims)) {
    return { allSupported: true, claims: [], unsupported: [], raw };
  }

  const claims: ClaimCheck[] = parsed.claims
    .filter((c): c is { claim: unknown; supported: unknown; reasoning?: unknown } =>
      typeof c === 'object' && c !== null
    )
    .map((c) => ({
      claim: String(c.claim ?? '').trim(),
      supported: c.supported !== false,
      reasoning: typeof c.reasoning === 'string' ? c.reasoning : undefined,
    }))
    .filter((c) => c.claim.length > 0);

  const unsupported = claims.filter((c) => !c.supported);
  return {
    allSupported: unsupported.length === 0,
    claims,
    unsupported,
    raw,
  };
}
