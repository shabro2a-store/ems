import webpush from 'web-push';

/**
 * Web Push, shared by the web app and the cron worker.
 *
 * It lives here rather than in apps/web because the ring repeater runs in the
 * worker: a caller's ring has to keep pushing until the driver answers, and a
 * job that can only alert through the web app would have to duplicate the
 * sender, the VAPID setup and the dead-subscription pruning.
 *
 * Optional throughout: with no VAPID keys configured every send is skipped and
 * the in-app alarm still works.
 */

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@shabro2a.com', pub, priv);
  configured = true;
  return true;
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  /**
   * Marks this as a driver ring rather than an ordinary notice. The service
   * worker escalates on it: it re-alerts an existing notification instead of
   * stacking a new one, and wakes any open tab so the in-app siren starts on
   * the push rather than on the next three-second poll.
   */
  ring?: boolean;
  /** Which repeat this is, 0-based. Only used to label the notification. */
  attempt?: number;
}

/** The Prisma surface this needs, so the package stays free of a schema import. */
export interface PushSubscriptionStore {
  pushSubscription: {
    findMany: (args: unknown) => Promise<
      Array<{ endpoint: string; p256dh: string; auth: string }>
    >;
    delete: (args: unknown) => Promise<unknown>;
  };
}

/** Best-effort push to every device a user has subscribed. Prunes dead subscriptions. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  db: PushSubscriptionStore,
): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = await db.pushSubscription.findMany({ where: { user_id: userId } });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          // A ring is worthless late: if the phone is off the network for
          // thirty seconds the order has moved on, so it expires rather than
          // arriving after the driver has already been called another way.
          payload.ring ? { TTL: 30, urgency: 'high' } : {},
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {});
        }
      }
    }),
  );
}
