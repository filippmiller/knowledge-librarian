/**
 * Shared constants for Telegram bot command parsing.
 * Used by voice-handler.ts and message-router.ts
 */

// Keywords that signal "add new knowledge"
// Matches at START of text: "добавь...", "запомни...", "сохрани..."
export const ADD_KEYWORDS =
  /^(добавь|добавить|запомни|запиши|сохрани|новое правило|добавить правило|запомни правило|запиши правило)/i;

// Keywords that signal "correct/change existing knowledge"
// Matches at START: "поменяй...", "измени...", "теперь..."
// OR anywhere: "... теперь ...", "... стало ...", "... изменилось ..."
export const CORRECT_KEYWORDS =
  /^(поменяй|поменять|измени|изменить|исправь|исправить|обнови|обновить|замени|заменить|теперь|сделай|сделать)|(.*\s(теперь|стало|было|изменилось|поменялось)\s.*)/i;

// Price/cost change patterns (can appear anywhere in text)
// Matches: "стоимость теперь...", "цена стала...", "сколько стоит теперь..."
export const PRICE_CHANGE_PATTERN =
  /(стоимость|цена|сколько стоит).*(теперь|стало|изменилась|поменялась|новая)/i;

// Pattern to detect direct rule edit by voice:
// "измени/поменяй/обнови/исправь правило R-5 новый текст"
// "R-5 теперь/новый текст"
export const DIRECT_EDIT_PATTERN =
  /^(?:измени|поменяй|обнови|исправь|замени|отредактируй)\s+(?:правило\s+)?(R-?\d+)\s+([\s\S]+)$/i;

// Pattern to detect direct rule lookup:
// - "правило/правила 100", "правило R-100", "покажи правило 100"
// - "R-100", "r-100", "р-100" (Latin or Cyrillic r with dash)
// - "R100", "r100", "р100" (Latin or Cyrillic r without dash)
// Must have either: word "правило/правила" OR letter R/r/р prefix before the number
export const RULE_LOOKUP_PATTERN = /(?:правил[оа]\s+(?:R-|r-|р-)?|(?:R|r|р)-?)(\d+)/i;
