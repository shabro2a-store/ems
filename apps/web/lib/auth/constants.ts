export const SHOP_TZ = 'Asia/Beirut';
export const BCRYPT_ROUNDS = 12;
export const PUNCH_RATE_LIMIT_PER_MIN = 5;
export const LOGIN_RATE_LIMIT_PER_MIN = 5;
export const ADVANCE_RATE_LIMIT_PER_MIN = 5;
export const IDEMPOTENCY_TTL_HOURS = 24;
export const SESSION_TTL_EMPLOYEE_MIN = 120;
// There is no token-refresh call anywhere in the client, so this is not a
// rolling/sliding window - it is the entire session length, fixed at login
// (or at the rare manual hit of POST /api/auth/refresh) for as long as the
// driver stays checked in. It must comfortably outlast any real shift.
export const SESSION_TTL_DRIVER_CHECKED_IN_MIN = 720;
export const CSRF_COOKIE_NAME = 'csrf';
export const ACCESS_COOKIE_NAME = 'ems_access';
export const REFRESH_COOKIE_NAME = 'ems_refresh';
export const SEED_DEFAULT_PASSWORD = 'change-me';