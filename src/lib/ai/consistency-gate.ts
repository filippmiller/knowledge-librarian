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
  verificationFailed?: boolean;
  /** Raw verifier response, for debugging. */
  raw?: string;
}

const VERIFIER_SYSTEM_PROMPT = `Ты — верификатор фактов. Твоя задача: проверить, что каждое конкретное утверждение в ответе подтверждено цитатами из источников.

ЧТО ПРОВЕРЯТЬ (факты-кандидаты):
- утверждения о наличии или отсутствии услуги ("мы делаем", "можно заказать", "доступно")
- обещания возможностей компании и обязательств перед клиентом
- условия применимости услуги (тип документа, язык, объём, формат, регион)
- адреса, номера домов, станции метро
- телефоны, email, URL
- цены и числа (рубли, проценты, количества)
- даты, сроки, дни недели, часы работы
- имена организаций и собственные имена
- специфические требования ("не заламинирован", "на русском", "с печатью")

ЧТО НЕ ПРОВЕРЯТЬ:
- только вежливые вводные и нейтральные связки без бизнес-смысла
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
  if (!answer.trim()) {
    return { allSupported: true, claims: [], unsupported: [] };
  }
  if (sourceChunks.length === 0) {
    return { allSupported: false, claims: [], unsupported: [], verificationFailed: true };
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
    // Business answers fail closed: the draft can still be shown, but the
    // caller must require human review when evidence verification is unavailable.
    return { allSupported: false, claims: [], unsupported: [], verificationFailed: true, raw: String(err) };
  }

  if (!raw) return { allSupported: false, claims: [], unsupported: [], verificationFailed: true, raw: '(empty)' };

  let parsed: { claims?: unknown };
  try {
    parsed = JSON.parse(normalizeJsonResponse(raw));
  } catch (err) {
    console.error('[consistency-gate] failed to parse verifier output:', err, 'raw:', raw.slice(0, 300));
    return { allSupported: false, claims: [], unsupported: [], verificationFailed: true, raw };
  }

  if (!Array.isArray(parsed.claims)) {
    return { allSupported: false, claims: [], unsupported: [], verificationFailed: true, raw };
  }

  const claims: ClaimCheck[] = parsed.claims
    .filter((c): c is { claim: unknown; supported: unknown; reasoning?: unknown } =>
      typeof c === 'object' && c !== null
    )
    .map((c) => {
      // Be conservative: a claim counts as supported ONLY on a strict boolean
      // `true`. A missing / non-boolean / malformed verifier value must NOT pass
      // as supported — otherwise a hallucinated claim slips through whenever the
      // verifier output is sloppy. When unsure, treat it as unsupported (the
      // claim is then stripped/regenerated) rather than trusting it.
      if (typeof c.supported !== 'boolean') {
        console.warn('[consistency-gate] non-boolean "supported" from verifier, treating as unsupported:', JSON.stringify(c.supported));
      }
      return {
        claim: String(c.claim ?? '').trim(),
        supported: c.supported === true,
        reasoning: typeof c.reasoning === 'string' ? c.reasoning : undefined,
      };
    })
    .filter((c) => c.claim.length > 0);

  if (claims.length === 0) {
    return { allSupported: false, claims: [], unsupported: [], verificationFailed: true, raw };
  }

  const unsupported = claims.filter((c) => !c.supported);
  return {
    allSupported: unsupported.length === 0,
    claims,
    unsupported,
    raw,
  };
}
