const BASE = 'https://avrora-library-production.up.railway.app';
const AUTH = 'Basic ' + Buffer.from('filipp:Airbus380+').toString('base64');

const questions = [
  'В каком формате нужно описывать ошибку в чате Bitrix24?',
  'Какие ошибки относятся к Типу 1?',
  'Что считается ошибкой менеджера?',
  'Как фиксировать смысловую ошибку переводчика?',
  'Что делать если переводчик потерял документ?',
];

for (const q of questions) {
  process.stdout.write(`\nQ: ${q}\n`);
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ question: q }),
  });
  if (!res.ok) {
    console.log(`  ERROR ${res.status}: ${await res.text()}`);
    continue;
  }
  const data = await res.json();
  const answer = data.answer || data.response || JSON.stringify(data).slice(0, 200);
  console.log(`A: ${answer.slice(0, 400)}`);
  if (data.confidence !== undefined) console.log(`   [confidence: ${data.confidence}]`);
}
