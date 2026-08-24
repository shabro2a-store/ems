import { prisma as defaultPrisma } from '@/lib/db/prisma';
import {
  sendPushToUser as send,
  vapidPublicKey,
  type PushPayload,
  type PushSubscriptionStore,
} from 'notify';
import type { PrismaClient } from '@prisma/client';

// Web Push moved into `notify` so the cron worker can send it too - the ring
// repeater lives there, because a caller's ring has to keep pushing until the
// driver answers and the web app is not running a timer for that. This wrapper
// keeps the app's existing call sites and the default prisma client.
export { vapidPublicKey };
export type { PushPayload };

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  db: PrismaClient = defaultPrisma,
): Promise<void> {
  // `notify` describes only the two methods it calls so the package needs no
  // generated-schema import; Prisma's own generic signatures do not structurally
  // match that. Same cast the package already uses for its recipient lookup.
  return send(userId, payload, db as unknown as PushSubscriptionStore);
}
