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
// How long an access token lives. Short on purpose: the proxy does not
// read the database, so this is how long an ended session (sign-out, reset,
// retirement) can keep working. The client renews it on a 401 with the
// refresh token (7 days, sliding), which is checked against session_version -
// so staying signed in costs nothing, and ending a session takes minutes.
export const ACCESS_TTL_MIN = 15;
export const REFRESH_TTL_DAYS = 7;
export const CSRF_COOKIE_NAME = 'csrf';
export const ACCESS_COOKIE_NAME = 'ems_access';
export const REFRESH_COOKIE_NAME = 'ems_refresh';
export const SEED_DEFAULT_PASSWORD = 'change-me';