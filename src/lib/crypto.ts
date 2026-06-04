import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

// Fail fast: never fall back to a hardcoded key. A weak/known key would let an
// attacker decrypt stored AI API keys and forge SSE processing tokens (bearer
// auth on the expensive process-stream endpoint). Require ≥32 bytes of entropy.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || Buffer.from(ENCRYPTION_KEY).length < 32) {
  throw new Error(
    'ENCRYPTION_KEY is missing or shorter than 32 bytes. Set a strong key (e.g. `openssl rand -hex 32`) in the environment.'
  );
}

// Derive a 32-byte AES-256 key. Derivation is intentionally unchanged from the
// original (first 32 bytes of the UTF-8 key material) so data encrypted with the
// existing production key still decrypts.
function getKey(): Buffer {
  return Buffer.from(ENCRYPTION_KEY as string).subarray(0, 32);
}

// URL-safe base64 encoding helpers
function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64Url(str: string): Buffer {
  // Add padding back if needed
  let padded = str.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  return Buffer.from(padded, 'base64');
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  const authTag = cipher.getAuthTag();

  // Combine IV + AuthTag + Encrypted data into single buffer, then base64url encode
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return toBase64Url(combined);
}

export function decrypt(encryptedData: string): string {
  try {
    const combined = fromBase64Url(encryptedData);
    
    // IV is first 16 bytes, authTag is next 16 bytes, rest is encrypted data
    const iv = combined.subarray(0, 16);
    const authTag = combined.subarray(16, 32);
    const encrypted = combined.subarray(32);

    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  } catch (error) {
    // Log details server-side only; do not leak crypto internals to callers.
    console.error('[crypto] Decryption failed:', error);
    throw new Error('Decryption failed');
  }
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 7) + '...' + key.slice(-4);
}

// Processing token for SSE authentication
// Token is valid for 10 minutes and tied to a specific document

interface ProcessingTokenPayload {
  documentId: string;
  exp: number; // expiration timestamp
  nonce: string;
}

const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export function createProcessingToken(documentId: string): string {
  const payload: ProcessingTokenPayload = {
    documentId,
    exp: Date.now() + TOKEN_EXPIRY_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  
  return encrypt(JSON.stringify(payload));
}

export function verifyProcessingToken(token: string, expectedDocumentId: string): { valid: boolean; error?: string } {
  try {
    const decrypted = decrypt(token);
    const payload: ProcessingTokenPayload = JSON.parse(decrypted);
    
    // Check expiration
    if (Date.now() > payload.exp) {
      return { valid: false, error: 'Token expired' };
    }
    
    // Check document ID matches
    if (payload.documentId !== expectedDocumentId) {
      return { valid: false, error: 'Token document mismatch' };
    }
    
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid token' };
  }
}
