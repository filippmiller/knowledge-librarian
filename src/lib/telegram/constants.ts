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
// Supports: "измени/изменить/поменяй/поменять/обнови/обновить/исправь/исправить/замени/заменить/отредактируй правило R-5 [на] новый текст"
// Code can be: R-5, R5, р-5, р5 (Cyrillic р), or just 5
export const DIRECT_EDIT_PATTERN =
  /^(?:измени(?:ть)?|поменяй|поменять|обнови(?:ть)?|исправь|исправить|замени(?:ть)?|отредактируй|отредактировать)\s+(?:правило\s+)?([RrрР][\s-]?\d+|\d+)\s+(?:на\s+)?([\s\S]+)$/i;

// Pattern to detect direct rule lookup:
// - "правило/правила 100", "правило R-100", "покажи правило 100"
// - "R-100", "r-100", "р-100" (Latin or Cyrillic r with dash)
// - "R100", "r100", "р100" (Latin or Cyrillic r without dash)
// Must have either: word "правило/правила" OR letter R/r/р prefix before the number
export const RULE_LOOKUP_PATTERN = /(?:правил[оа]\s+(?:R-|r-|р-)?|(?:R|r|р)-?)(\d+)/i;
