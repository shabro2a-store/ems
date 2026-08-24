import { PrismaClient } from '@prisma/client';
import { sendPushToUser, type PushSubscriptionStore } from 'notify';
import { prisma as defaultPrisma } from '../db/prisma';

/**
 * The backstop on a ring nobody ever answers.
 *
 * The owner's rule is that it rings until the driver shuts it off, and that is
 * what it does - every five seconds, indefinitely as far as any driver standing
 * in a shop is concerned. This is only the point at which the system accepts
 * that nobody is going to answer.
 *
 * It cannot be removed. An unbounded loop pushes twelve times a minute forever
 * at a phone that is switched off or locked in a drawer overnight: the driver
 * comes back to hundreds of queued alerts, the battery is gone, and the VAPID
 * key is the thing Google rate-limits. Five minutes is far past the point where
 * the counter has given the order to somebody else, and it stays a single named
 * constant so raising it is one edit.
 *
 * The web app's own RING_WINDOW_MS is pinned to this by ringRepeater.test.ts:
 * if the in-app alarm gave up before the pushes did, a driver holding an open
 * app would watch the alarm screen vanish while their phone kept buzzing.
 */
export const RING_REPEAT_WINDOW_MS = 5 * 60_000;

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
 * So the ring repeats on a five-second tick until the driver acknowledges it,
 * exactly like a phone ringing, and stops on the very next tick after they tap -
 * `acknowledged_at` is set by /api/me/calls/ack and every repeat is filtered on
 * it being null. RING_REPEAT_WINDOW_MS is a backstop for the phone that never
 * answers at all, not the length of the ring.
 *
 * Note precisely what a push can and cannot reach, because the two cases sound
 * completely different to a driver:
 *
 *  - App RUNNING, even backgrounded with the screen off: the service worker
 *    hands the push to the page, which blasts a looping siren at media volume.
 *    DriverAlarm keeps the page alive for exactly this. This is the loud case.
 *  - App SWIPED AWAY, or the phone rebooted: there is no page, so nothing can
 *    play. A service worker has no audio output and no API grants it one. All
 *    that is left is the notification, and its loudness belongs to the Android
 *    channel - a per-handset setting no website can reach.
 *
 * The second case is why RUNBOOK "Making the driver ring loud" asks for a
 * ringtone on the channel rather than a notification blip.
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
