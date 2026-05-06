import type { ScenarioKey } from './scenarios';

/**
 * Deterministic migration/upload classifier for the current apostille corpus.
 * This is intentionally conservative: ambiguous content stays untagged instead
 * of becoming globally visible to every scenario.
 */
export function classifyDocumentScenario(filename: string, title: string): ScenarioKey | null {
  const text = normalizeScenarioText(`${filename} ${title}`);
  if (/мин\s*юст|минюст|министерств\w*\s+юстиц/.test(text)) return 'apostille.min_justice';
  if (/(?:^|[^а-яё])ло(?:[^а-яё]|$)|ленинградск/.test(text)) return 'apostille.zags.lo';
  if (/загс/.test(text)) return 'apostille.zags.spb';
  return null;
}

export function classifyRuleScenario(title: string, body: string, locationHint?: string | null): ScenarioKey | null {
  const text = normalizeScenarioText(`${title} ${body} ${locationHint ?? ''}`);

  if (looksCrossCuttingApostille(text)) return 'apostille';
  if (/опек|мин\s*юст|минюст|мю|оптиков|исаакиевск|нотариальн/.test(text)) {
    return 'apostille.min_justice';
  }
  if (/ленинградск|смольн|539\s*[-–]?\s*43\s*[-–]?\s*63|загс\s+ло|органами\s+загс\s+ло/.test(text)) {
    return 'apostille.zags.lo';
  }
  if (/кзагс|фурштад|фурштат|272\s*[-–]?\s*21\s*[-–]?\s*10|273\s*[-–]?\s*37\s*[-–]?\s*17|санкт[\s-]*петербург/.test(text)) {
    return 'apostille.zags.spb';
  }
  if (/апостил/.test(text)) return null;
  return null;
}

export function looksCrossCuttingApostille(text: string): boolean {
  const normalized = normalizeScenarioText(text);
  return CROSS_CUTTING_PATTERNS.some((re) => re.test(normalized));
}

function normalizeScenarioText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

const CROSS_CUTTING_PATTERNS = [
  /всегда\s+проставляется\s+на\s+русском/,
  /2500\s*рубл/,
  /государственная\s+пошлина.{0,30}2500/,
  /гаагск\w+\s+конвенц/,
  /принимающей\s+стороны/,
  /не\s+должен\s+(?:советовать|решать)/,
  /добиться\s+от\s+клиента\s+принятия\s+решения/,
  /апостил\w+\s+(?:м\.?б\.?|может\s+быть)\s+проставлен\s+(?:или\s+на\s+сам\w*|либо)/,
  /подлинность\s+подписи\s+чиновника/,
  /подлинность\s+подписи\s+переводчика/,
];
