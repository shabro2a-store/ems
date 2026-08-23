import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';

export type TelegramSendResult =
  | { ok: true }
  | { ok: false; reason: 'NO_TOKEN' | 'NOT_BOUND' | 'TELEGRAM_ERROR'; detail?: string };

/**
 * The chat alerts are delivered to, resolved the way the notifier resolves it.
 *
 * Deliberately `telegram_chat_id: { not: null }` and ordered, not "any admin".
 * The plain `findFirst({ role: 'ADMIN' })` this replaced picked an arbitrary
 * admin row: with two admin accounts it could return the one who never bound a
 * phone, whose chat_id is null, and every alert in the system would then be
 * dropped with one line on stdout that nobody reads. Preferring a bound admin
 * means a second admin account can never silence the first one's alerts.
 */
export async function boundAdminChatId(
  db: PrismaClient = defaultPrisma,
): Promise<string | null> {
  const admin = await db.user.findFirst({
    where: { role: 'ADMIN', telegram_chat_id: { not: null } },
    orderBy: { created_at: 'asc' },
    select: { telegram_chat_id: true },
  });
  return admin?.telegram_chat_id ?? null;
}

/**
 * Send one message and say what actually happened.
 *
 * The TelegramNotifier deliberately swallows failures - it is called from cron
 * jobs where a dead bot must not take the job down with it. That is wrong for
 * the two places a person is waiting on the answer: the test button, whose
 * whole job is to prove the chain works, and the disconnect notice. A silent
 * failure there is worse than none, because it reads as success.
 */
export async function sendToChat(chatId: string, text: string): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!token) return { ok: false, reason: 'NO_TOKEN' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (res.ok) return { ok: true };
    // Telegram's own description is the useful half - "chat not found",
    // "bot was blocked by the user", "Unauthorized" each mean a different fix.
    const body = (await res.json().catch(() => null)) as { description?: string } | null;
    return {
      ok: false,
      reason: 'TELEGRAM_ERROR',
      detail: body?.description ?? `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'TELEGRAM_ERROR',
      detail: e instanceof Error ? e.message : 'network error',
    };
  }
}
