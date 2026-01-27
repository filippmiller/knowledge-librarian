import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production-32';
const ALGORITHM = 'aes-256-gcm';

// Ensure key is exactly 32 bytes
function getKey(): Buffer {
  const key = Buffer.from(ENCRYPTION_KEY);
  if (key.length >= 32) {
    return key.subarray(0, 32);
  }
  // Pad if too short
  const padded = Buffer.alloc(32);
  key.copy(padded);
  return padded;
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
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  } catch (error) {
    return { valid: false, error: 'Invalid token' };
  }
}