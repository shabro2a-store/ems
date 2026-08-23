import { ConsoleNotifier } from './console';
import { TelegramNotifier } from './telegram';
import { Notifier } from './types';

let cached: Notifier | null = null;

type RecipientPrisma = { user: { findFirst: (args: unknown) => Promise<{ telegram_chat_id: string | null } | null> } };
let recipientPrisma: RecipientPrisma | null = null;

async function getRecipientPrisma(): Promise<RecipientPrisma> {
  if (!recipientPrisma) {
    const { PrismaClient } = await import('@prisma/client');
    recipientPrisma = new PrismaClient() as unknown as RecipientPrisma;
  }
  return recipientPrisma;
}

export function makeNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  const token = env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const publicAppUrl = env.PUBLIC_APP_URL ?? 'http://localhost:3000';

  if (token && token.length > 10) {
    return new TelegramNotifier({
      botToken: token,
      webhookSecret,
      publicAppUrl,
      resolveRecipient: async () => {
        // Lazy import to avoid loading Prisma on cold paths, then keep the
        // client: the cron jobs notify every minute, and a connect/disconnect
        // per message churns through Postgres connections for no benefit.
        const prisma = await getRecipientPrisma();
        // `telegram_chat_id: { not: null }` and an explicit order, not "any
        // admin". An unordered findFirst over the admins could return one who
        // never bound a phone, whose chat_id is null - and then every alert in
        // the system is dropped with one console line nobody reads. Mirrors
        // boundAdminChatId in apps/web/lib/services/telegramSend.ts.
        const admin = await prisma.user.findFirst({
          where: { role: 'ADMIN', telegram_chat_id: { not: null } },
          orderBy: { created_at: 'asc' },
          select: { telegram_chat_id: true },
        });
        return admin?.telegram_chat_id ?? null;
      },
    });
  }
  return new ConsoleNotifier();
}

export function getNotifier(): Notifier {
  if (!cached) cached = makeNotifier();
  return cached;
}

export const notifier: Notifier = new ConsoleNotifier(); // default export; worker uses getNotifier()
export type { Notifier, NotificationPayload } from './types';