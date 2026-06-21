import * as crypto from 'crypto';

/**
 * Validate Azure DevOps webhook HMAC-SHA1 signature.
 * Returns true if no secret is configured (skip validation).
 */
export function validateSignature(
  payload: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (!signature) return false;

  const expectedPrefix = 'sha1=';
  if (!signature.startsWith(expectedPrefix)) return false;

  const providedSignature = signature.slice(expectedPrefix.length);
  const expectedSignature = crypto
    .createHmac('sha1', secret)
    .update(payload, 'utf8')
    .digest('base64');

  try {
    const providedBuffer = Buffer.from(providedSignature, 'base64');
    const expectedBuffer = Buffer.from(expectedSignature, 'base64');
    if (providedBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
