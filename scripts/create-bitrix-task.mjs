import 'dotenv/config';

const WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL;
const RESPONSIBLE_ID = process.env.BITRIX24_WEBHOOK_USER_ID;

if (!WEBHOOK_URL) {
  console.error('BITRIX24_WEBHOOK_URL is not set');
  process.exit(1);
}

const title = process.argv[2];
const description = process.argv[3];

if (!title || !description) {
  console.error('Usage: node scripts/create-bitrix-task.mjs "Title" "Description"');
  process.exit(1);
}

const url = `${WEBHOOK_URL}tasks.task.add.json`;
const body = {
  fields: {
    TITLE: title,
    DESCRIPTION: description,
    RESPONSIBLE_ID: RESPONSIBLE_ID ? Number(RESPONSIBLE_ID) : undefined,
    PRIORITY: '2', // high
  },
};

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    console.error('Bitrix error:', data.error);
    process.exit(1);
  }
  console.log('Task created:', data.result?.task?.id ?? JSON.stringify(data));
} catch (err) {
  console.error('Request failed:', err.message);
  process.exit(1);
}
