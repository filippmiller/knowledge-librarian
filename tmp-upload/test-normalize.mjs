function escapeControlCharsInStrings(json) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escaped) { escaped = false; result += char; }
      else if (char === '\\') { escaped = true; result += char; }
      else if (char === '"') { inString = false; result += char; }
      else if (char === '\n') { result += '\\n'; }
      else if (char === '\r') { result += '\\r'; }
      else { result += char; }
    } else {
      if (char === '"') inString = true;
      result += char;
    }
  }
  return result;
}

// Simulate what the AI actually returns (code fence + JSON with literal newlines in body)
const raw = "```json\n{\n  \"rules\": [\n    {\n      \"ruleCode\": \"R-234\",\n      \"title\": \"Title\",\n      \"body\": \"Line 1\nLine 2\nLine 3\",\n      \"tags\": []\n    }\n  ],\n  \"qaPairs\": [],\n  \"uncertainties\": []\n}\n```";

console.log('=== RAW (first 200) ===');
console.log(JSON.stringify(raw.slice(0, 200)));

// Strip fence
let trimmed = raw.trim();
const firstNewline = trimmed.indexOf('\n');
trimmed = trimmed.slice(firstNewline + 1).trim();
const closingFence = trimmed.lastIndexOf('\n```');
if (closingFence !== -1) {
  trimmed = trimmed.slice(0, closingFence).trim();
} else if (trimmed.endsWith('`')) {
  trimmed = trimmed.replace(/`+\s*$/, '').trim();
}
console.log('\n=== After fence strip (first 200) ===');
console.log(JSON.stringify(trimmed.slice(0, 200)));

trimmed = escapeControlCharsInStrings(trimmed);
console.log('\n=== After escape (first 200) ===');
console.log(JSON.stringify(trimmed.slice(0, 200)));

try {
  const r = JSON.parse(trimmed);
  console.log('\n=== Parsed OK ===');
  console.log('rules:', r.rules?.length, ', body:', r.rules?.[0]?.body);
} catch(e) {
  console.log('\n=== Parse FAILED ===', e.message);
}
