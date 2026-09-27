import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { prisma } from '@/lib/db/prisma';
import { telegramBotUsername } from '@/lib/services/telegramSend';
import { webhookSecretUsable } from '@/lib/services/telegramConfig';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const me = await identity();
  if (!me) return unauthorized();
  const userId = me.userId;
  const role = me.role;
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const admin = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, telegram_chat_id: true },
  });
  if (!admin) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const configured = Boolean(process.env.TELEGRAM_BOT_TOKEN);

  // The webhook secret is what proves an update really came from Telegram.
  // docker-compose falls back to a literal that is committed to this repo, so
  // "unset" looks identical to "set" from the outside and nothing would ever
  // fail - the owner has to be shown it, or he will never find out.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const webhookSecretOk = webhookSecretUsable(secret);

  // A link to the bot, nothing more. Binding is open by the owner's ruling:
  // whoever opens this and presses START receives the alerts, and the first
  // chat to do it holds them until somebody presses Disconnect. There is no
  // code to carry because the manager who holds the work phone has no login
  // here and never will.
  const username = await telegramBotUsername();
  const bindUrl = username ? `https://t.me/${username}` : null;

  return NextResponse.json({
    ok: true,
    data: {
      bound: Boolean(admin.telegram_chat_id),
      bot_configured: configured,
      webhook_secret_ok: webhookSecretOk,
      bind_url: bindUrl,
    },
  });
}

export const dynamic = 'force-dynamic';
