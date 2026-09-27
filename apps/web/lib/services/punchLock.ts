/**
 * The per-person punch lock, shared by everything that writes a punch: the
 * employee's own (punch.ts) and the system's (autoClose.ts). See punch.ts for
 * why it is an advisory lock at all.
 */
export const PUNCH_LOCK_NAMESPACE = 8_723_411;

/**
 * The advisory-lock key for one user, computed here rather than in SQL.
 *
 * Postgres has hashtext/hashtextextended, but which overload of
 * pg_advisory_xact_lock a driver's parameter types resolve to is not something
 * to find out in production - this runs on every punch, and a function that
 * fails to resolve would stop every employee clocking in. A key computed in
 * JavaScript is one bigint parameter with one obvious cast, and it can be
 * tested without a database.
 *
 * FNV-1a over `namespace:userId`, folded into the signed 64-bit range the
 * function takes. Collisions between two users would only ever cost one of them
 * a short wait, never a wrong answer - the lock orders writes, it does not
 * decide them.
 */
export function punchLockKey(userId: string): bigint {
  // Constructor calls rather than 0n literals: this package targets ES2017 and
  // raising that for one hash is not a trade worth making. Node runs it either
  // way.
  const MASK = BigInt('0xffffffffffffffff');
  const PRIME = BigInt('0x100000001b3');
  let hash = BigInt('0xcbf29ce484222325');
  for (const ch of `${PUNCH_LOCK_NAMESPACE}:${userId}`) {
    hash = ((hash ^ BigInt(ch.charCodeAt(0))) * PRIME) & MASK;
  }
  return BigInt.asIntN(64, hash);
}
