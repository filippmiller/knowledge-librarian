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

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Return IV + AuthTag + Encrypted data as hex
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
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