export const SHOP_TZ = 'Asia/Beirut';
export const BCRYPT_ROUNDS = 12;
export const PUNCH_RATE_LIMIT_PER_MIN = 5;
// Sign-in attempts per account, whatever address they come from: 10 in 15
// minutes. Counted per ACCOUNT because the address is whatever the client says
// it is unless Cloudflare vouches for it, and rotating it made the old
// per-(username, address) limit disappear.
export const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
export const LOGIN_ACCOUNT_WINDOW_MS = 15 * 60_000;
// And per address Cloudflare vouches for, to slow one machine trying many names.
export const LOGIN_ATTEMPTS_PER_ADDRESS = 30;
export const LOGIN_ADDRESS_WINDOW_MS = 60_000;
export const PASSWORD_MIN_LENGTH = 8;
export const ADVANCE_RATE_LIMIT_PER_MIN = 5;
export const IDEMPOTENCY_TTL_HOURS = 24;
export const SESSION_TTL_EMPLOYEE_MIN = 120;
// There is no token-refresh call anywhere in the client, so this is not a
// rolling/sliding window - it is the entire session length, set once when the
// driver punches IN (POST /api/me/punch re-issues the access cookie) and reset
// to SESSION_TTL_EMPLOYEE_MIN when they punch OUT. It must therefore comfortably
// outlast any real shift on its own.
export const SESSION_TTL_DRIVER_CHECKED_IN_MIN = 720;
export const CSRF_COOKIE_NAME = 'csrf';
export const ACCESS_COOKIE_NAME = 'ems_access';
export const REFRESH_COOKIE_NAME = 'ems_refresh';
export const SEED_DEFAULT_PASSWORD = 'change-me';