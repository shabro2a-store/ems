import { PrismaClient } from '@prisma/client';
import { sendPushToUser, type PushSubscriptionStore } from 'notify';
import { prisma as defaultPrisma } from '../db/prisma';

/**
 * How long a ring keeps ringing if nobody answers it.
 *
 * A phone call rings for about this long and then stops; so does this. Past it
 * the caller can see on their board that the driver never answered and ring
 * again or pick somebody else, which is a better outcome than a notification
 * that pesters a driver who is mid-delivery on the road.
 */
export const RING_REPEAT_WINDOW_MS = 45_000;

export interface RingRepeaterOpts {
  db?: PrismaClient;
  now?: Date;
}

export interface RingRepeaterResult {
  /** Rings still unanswered and inside the window, so re-pushed on this tick. */
  repushed: number;
}

/**
 * Keep pushing an unanswered ring until the driver acknowledges it.
 *
 * `ringDriver` fires exactly one push, and that was the whole alert: one
 * notification, at whatever volume the phone's notification channel happens to
 * use, gone in a second. A driver with the phone in a pocket misses it and
 * nothing else ever happens - the counter is left watching a board that says
 * the driver was rung, with no way to tell whether the phone made a sound.
 *
 * So the ring repeats on a five-second tick while it is unanswered, exactly
 * like a phone ringing, and stops the instant the driver taps - `acknowledged_at`
 * is set by /api/me/calls/ack and every repeat is filtered on it being null.
 *
 * Note what this cannot do. No web page can play audio while the browser is
 * closed; a service worker has no audio output and there is no API for one. All
 * a push can do on a locked phone is raise a notification, and how loud that is
 * belongs to the Android notification channel, which is a per-handset setting no
 * website can reach. Repeating is the whole of what the platform allows - see
 * RUNBOOK "Making the driver ring loud".
 */
export async function runRingRepeater(
  opts: RingRepeaterOpts = {},
): Promise<RingRepeaterResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const pending = await db.driverCall.findMany({
    where: {
      acknowledged_at: null,
      created_at: { gte: new Date(now.getTime() - RING_REPEAT_WINDOW_MS) },
    },
    select: { id: true, driver_id: true, created_at: true },
  });

  for (const call of pending) {
    const elapsedMs = now.getTime() - call.created_at.getTime();
    await sendPushToUser(
      call.driver_id,
      {
        title: '📞 Order ready!',
        body: 'The counter is calling you. Open the app to answer.',
        url: '/driver',
        ring: true,
        attempt: Math.max(1, Math.round(elapsedMs / 5_000)),
      },
      db as unknown as PushSubscriptionStore,
    );
  }

  return { repushed: pending.length };
}
