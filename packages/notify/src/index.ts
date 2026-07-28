import { ConsoleNotifier } from './console';
import { TelegramNotifier } from './telegram';
import { Notifier } from './types';

let cached: Notifier | null = null;

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
        // Lazy import to avoid loading Prisma on cold paths.
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        try {
          const admin = await prisma.user.findFirst({
            where: { role: 'ADMIN' },
            select: { telegram_chat_id: true },
          });
          return admin?.telegram_chat_id ?? null;
        } finally {
          await prisma.$disconnect();
        }
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