/**
 * The worker's copy of punchLockKey in apps/web/lib/services/punchLock.ts. The
 * worker cannot import from apps/web; punchLock.test.ts pins the two together,
 * because two keys for one person would be two locks - no lock at all.
 */
const PUNCH_LOCK_NAMESPACE = 8_723_411;

export function punchLockKey(userId: string): bigint {
  const MASK = BigInt('0xffffffffffffffff');
  const PRIME = BigInt('0x100000001b3');
  let hash = BigInt('0xcbf29ce484222325');
  for (const ch of `${PUNCH_LOCK_NAMESPACE}:${userId}`) {
    hash = ((hash ^ BigInt(ch.charCodeAt(0))) * PRIME) & MASK;
  }
  return BigInt.asIntN(64, hash);
}
