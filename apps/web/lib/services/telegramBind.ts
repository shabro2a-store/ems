import { createHmac, timingSafeEqual } from 'crypto';

// A short code the admin reads off the app and sends to the bot as
// `/start <code>`. It is derived from JWT_SECRET rather than stored, so binding
// needs no schema change and no cleanup job: possession of a current code
// proves the sender was looking at an authenticated admin screen moments ago.
export const BIND_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_DIGITS = 6;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required to derive a Telegram bind code');
  return s;
}

function codeForWindow(adminId: string, windowIndex: number): string {
  const mac = createHmac('sha256', secret())
    .update(`telegram-bind:${adminId}:${windowIndex}`)
    .digest();
  const n = mac.readUInt32BE(0) % 10 ** CODE_DIGITS;
  return String(n).padStart(CODE_DIGITS, '0');
}

export function currentBindCode(
  adminId: string,
  now: Date = new Date(),
): { code: string; expiresInSec: number } {
  const windowIndex = Math.floor(now.getTime() / BIND_CODE_TTL_MS);
  const expiresAt = (windowIndex + 1) * BIND_CODE_TTL_MS;
  return {
    code: codeForWindow(adminId, windowIndex),
    expiresInSec: Math.max(0, Math.floor((expiresAt - now.getTime()) / 1000)),
  };
}

// Accepts the current window and the previous one, so a code read just before a
// rollover still works. Compared in constant time.
export function verifyBindCode(
  adminId: string,
  supplied: string,
  now: Date = new Date(),
): boolean {
  const cleaned = supplied.trim();
  if (!/^\d{6}$/.test(cleaned)) return false;
  const windowIndex = Math.floor(now.getTime() / BIND_CODE_TTL_MS);
  return [windowIndex, windowIndex - 1].some((w) => {
    const expected = Buffer.from(codeForWindow(adminId, w));
    const got = Buffer.from(cleaned);
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
}
