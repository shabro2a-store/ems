import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { headers } from 'next/headers';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function reply(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => null);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; is_bot: boolean; first_name: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}

export async function POST(req: Request) {
  const h = headers();
  // Fails CLOSED. This used to be `if (expected && ...)`, which meant an empty
  // TELEGRAM_WEBHOOK_SECRET skipped the check altogether and left the endpoint
  // open to the internet - the one shape of mistake where forgetting to set a
  // variable removes a guard instead of breaking loudly. There is nothing to
  // guard when no bot exists, so an unconfigured install still answers.
  const provided = req.headers.get('x-telegram-bot-api-secret-token');
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const botConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  if (botConfigured && (!expected || provided !== expected)) {
    return jsonError('FORBIDDEN', 'Bad webhook secret', 403);
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return jsonError('INVALID_INPUT', 'Body must be JSON', 400);
  }

  const text = update.message?.text ?? '';
  const chatId = update.message?.chat?.id;

  if (!chatId) {
    return NextResponse.json({ ok: true, data: { skipped: true } });
  }

  if (text === '/help') {
    await reply(
      chatId,
      `<b>Shabro2a EMS bot</b>
` +
        `This bot only sends alerts — every action happens in the app.

` +
        `<b>/start</b> — send alerts to this chat.
` +
        `<b>/stop</b> — stop sending them here.
` +
        `<b>/help</b> — this message.`,
    );
    return NextResponse.json({ ok: true, data: { helped: true } });
  }

  // Binding is open, and that is the owner's ruling: he sets the bot up, sends
  // /start from the work phone once, and it works from then on - nothing to
  // expire, no code to fetch from a dashboard the manager cannot reach. The bot
  // only ever SENDS, so what a wrong chat would get is the alert feed, never
  // control of anything.
  //
  // The one rule kept is first-come. A bind that let ANY /start take over would
  // let a later chat silently replace the work phone: the owner would simply
  // stop receiving alerts, with nothing anywhere to say why. So the first chat
  // wins, and a second is pointed at Disconnect - a button the owner already
  // has. Nothing anybody means to do is blocked; only the silent takeover is.
  if (text.startsWith('/start')) {
    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      orderBy: { created_at: 'asc' },
      select: { id: true, username: true, telegram_chat_id: true },
    });
    if (!admin) {
      return jsonError('NOT_FOUND', 'No admin user found', 404);
    }

    const mine = String(chatId);
    if (admin.telegram_chat_id === mine) {
      await reply(chatId, `✅ Already connected. Alerts come here.`);
      return NextResponse.json({ ok: true, data: { alreadyBound: true } });
    }
    if (admin.telegram_chat_id) {
      await reply(
        chatId,
        `🔒 Alerts are already going to another chat.

To move them here, open the app as admin → <b>Dashboard → Telegram alerts → Disconnect</b>, then send /start again.`,
      );
      return NextResponse.json({ ok: true, data: { rejected: 'already_bound' } });
    }

    await prisma.user.update({
      where: { id: admin.id },
      data: { telegram_chat_id: mine },
    });
    await reply(
      chatId,
      `👋 Connected.
` +
        `Alerts will come here for:
` +
        `• Missed checkouts
` +
        `• Trip over-threshold
` +
        `• Driver out &gt;4h
` +
        `• End-of-day watch
` +
        `• Advance requests
` +
        `• Daily summary (23:00)

` +
        `Send /stop to turn them off, or /help for the command list.`,
    );
    return NextResponse.json({ ok: true, data: { bound: admin.id } });
  }

  // Whoever holds the phone can turn the alerts off from the phone itself.
  // The same thing Disconnect does, for the person with the handset rather than
  // the one with the login.
  if (text === '/stop') {
    const cleared = await prisma.user.updateMany({
      where: { role: 'ADMIN', telegram_chat_id: String(chatId) },
      data: { telegram_chat_id: null },
    });
    await reply(
      chatId,
      cleared.count > 0
        ? `🔌 Stopped. No more alerts here. Send /start to turn them back on.`
        : `This chat was not receiving alerts.`,
    );
    return NextResponse.json({ ok: true, data: { stopped: cleared.count > 0 } });
  }

  // Other messages: silently ack so Telegram doesn't retry.
  return NextResponse.json({ ok: true, data: { skipped: true } });
}

export const dynamic = 'force-dynamic';