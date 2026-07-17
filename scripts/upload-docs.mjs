/**
 * upload-docs.mjs
 * Upload documents to the Knowledge Librarian admin API.
 * Usage: KL_USER=filipp KL_PASS=xxx node scripts/upload-docs.mjs <file1> [file2] ...
 *
 * Env vars:
 *   KL_URL  - base URL (default: https://avrora-library-production.up.railway.app)
 *   KL_USER - basic auth username
 *   KL_PASS - basic auth password
 *
 * Uses native Node.js 18+ fetch + FormData (no extra deps).
 */
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.KL_URL || 'https://avrora-library-production.up.railway.app';
const USER = process.env.KL_USER;
const PASS = process.env.KL_PASS;

if (!USER || !PASS) {
  console.error('❌  Set KL_USER and KL_PASS env vars');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: KL_USER=x KL_PASS=y node scripts/upload-docs.mjs <file1> [file2] ...');
  process.exit(1);
}

for (const filePath of files) {
  const absPath = path.resolve(filePath);
  const filename = path.basename(absPath);

  if (!fs.existsSync(absPath)) {
    console.error(`❌  File not found: ${absPath}`);
    continue;
  }

  console.log(`\n📄 Uploading: ${filename}`);

  const fileBuffer = fs.readFileSync(absPath);
  const blob = new Blob([fileBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  const form = new FormData();
  form.append('file', blob, filename);
  form.append('title', filename.replace(/\.docx$/i, '').replace(/_/g, ' '));

  try {
    const res = await fetch(`${BASE_URL}/api/documents`, {
      method: 'POST',
      headers: { Authorization: AUTH },
      body: form,
    });

    let json;
    try { json = await res.json(); } catch { json = {}; }

    if (res.ok) {
      console.log(`✅  Uploaded → id: ${json.id}`);
    } else {
      console.error(`❌  HTTP ${res.status}: ${json.error || JSON.stringify(json)}`);
    }
  } catch (err) {
    console.error(`❌  Network error: ${err.message}`);
  }
}

console.log(`\nГотово. Откройте ${BASE_URL}/admin/documents чтобы запустить обработку.`);
