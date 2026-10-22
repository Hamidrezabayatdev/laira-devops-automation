import crypto from 'crypto';

/**
 * CSRF Protection utilities.
 */

const CSRF_SECRET = process.env.AUTH_SECRET || 'liara-csrf-fallback-development-key';

export function generateCsrfToken(sessionId: string): string {
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(`${sessionId}:${timestamp}`)
    .digest('hex');
  return `${timestamp}.${signature}`;
}

export function verifyCsrfToken(sessionId: string, token: string, maxAgeMs = 3600000): boolean {
  if (!token || !token.includes('.')) return false;
  const [timestampStr, providedSignature] = token.split('.');
  if (!timestampStr || !providedSignature) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const now = Date.now();
  // Reject future timestamp and expired token
  if (timestamp > now || now - timestamp > maxAgeMs) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(`${sessionId}:${timestampStr}`)
    .digest('hex');

  const provBuf = Buffer.from(providedSignature);
  const expBuf = Buffer.from(expectedSignature);

  // timingSafeEqual requires buffers of identical byte length, otherwise throws RangeError
  if (provBuf.length !== expBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(provBuf, expBuf);
}
