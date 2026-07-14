import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Standard local development fallback key (32 bytes hex) - ONLY used for fallback with warning!
const DEV_FALLBACK_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
  let rawKey = process.env.ENCRYPTION_KEY;

  if (!rawKey || rawKey.includes('your-super-secret') || rawKey.trim() === '') {
    console.warn(
      '\x1b[31m%s\x1b[0m',
      '🚨 SECURITY WARNING: ENCRYPTION_KEY is not configured or is default. Falling back to insecure development key.'
    );
    rawKey = DEV_FALLBACK_KEY;
  }

  // Key must be 32 bytes (64 hex characters)
  try {
    const buffer = Buffer.from(rawKey, 'hex');
    if (buffer.length !== 32) {
      throw new Error(`Encryption key must be exactly 32 bytes (64 hex characters). Got ${buffer.length} bytes.`);
    }
    return buffer;
  } catch (error: any) {
    console.error('❌ Failed to parse ENCRYPTION_KEY:', error.message);
    // In case the key is not valid hex or wrong size, fall back to DEV_FALLBACK_KEY
    return Buffer.from(DEV_FALLBACK_KEY, 'hex');
  }
}

/**
 * Encrypts a string using AES-256-CBC with a random IV.
 * Returns formatted string: 'iv_hex:ciphertext_hex'
 */
export function encrypt(text: string): string {
  if (!text) return '';
  
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a string formatted as 'iv_hex:ciphertext_hex'.
 */
export function decrypt(encryptedData: string): string {
  if (!encryptedData) return '';
  
  const parts = encryptedData.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format. Expected "iv:ciphertext".');
  }
  
  const ivHex = parts[0];
  const ciphertextHex = parts[1];
  
  if (!ivHex || !ciphertextHex) {
    throw new Error('Invalid encrypted data values.');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(ciphertextHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted.toString('utf8');
}

/**
 * Masks a sensitive string for logging purposes.
 * e.g., "mysecretpassword" -> "mys...ord"
 */
export function maskString(text: string, visibleLength = 3): string {
  if (!text) return '';
  if (text.length <= visibleLength * 2) {
    return '***';
  }
  return `${text.slice(0, visibleLength)}...${text.slice(-visibleLength)}`;
}
