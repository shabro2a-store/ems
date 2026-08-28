import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { headers } from 'next/headers';
import { verifyBindCode } from '@/lib/services/telegramBind';

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
      `<b>Shabro2a EMS bot</b>\n` +
        `This bot only sends alerts — every action happens in the app.\n\n` +
        `<b>/start &lt;code&gt;</b> — bind this chat to the admin account. Get the code from the app: Dashboard → Telegram alerts.\n` +
        `<b>/help</b> — this message.`,
    );
    return NextResponse.json({ ok: true, data: { helped: true } });
  }

  if (text.startsWith('/start')) {
    // Binding is gated on a short-lived code that only an authenticated admin
    // screen displays. Without it any stranger who found the bot could point
    // the whole alert feed at their own chat.
    const supplied = text.slice('/start'.length).trim();
    // Every admin, not findFirst. The code shown in the app is derived from the
    // id of the admin who is logged in (see currentBindCode); an unordered
    // findFirst here checked it against a possibly different admin, so with two
    // admin accounts a perfectly valid code could never verify. Trying them all
    // makes the two sides agree by construction rather than by luck of row
    // order, and the HMAC is what decides - not the query.
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      orderBy: { created_at: 'asc' },
      select: { id: true, username: true },
    });
    if (admins.length === 0) {
      return jsonError('NOT_FOUND', 'No admin user found', 404);
    }

    if (!supplied) {
      await reply(
        chatId,
        `🔒 This chat is not bound.\n\nOpen the app as admin → <b>Dashboard → Telegram alerts</b>, then send:\n<code>/start 123456</code>\n(using the 6-digit code shown there).`,
      );
      return NextResponse.json({ ok: true, data: { needsCode: true } });
    }

    const admin = admins.find((a) => verifyBindCode(a.id, supplied));
    if (!admin) {
      await reply(chatId, `❌ That code is wrong or expired. Codes last 10 minutes — grab a fresh one from the app and try again.`);
      return NextResponse.json({ ok: true, data: { rejected: true } });
    }

    await prisma.user.update({
      where: { id: admin.id },
      data: { telegram_chat_id: String(chatId) },
    });
    await reply(
      chatId,
      `👋 Bound to admin <b>${admin.username}</b>.\n` +
        `You will now receive alerts for:\n` +
        `• Missed checkouts\n` +
        `• Trip over-threshold\n` +
        `• Driver out &gt;4h\n` +
        `• End-of-day watch\n` +
        `• Advance requests\n` +
        `• Daily summary (23:00)\n\n` +
        `Reply /help for the command list.`,
    );
    return NextResponse.json({ ok: true, data: { bound: admin.id } });
  }

  // Other messages: silently ack so Telegram doesn't retry.
  return NextResponse.json({ ok: true, data: { skipped: true } });
}

export const dynamic = 'force-dynamic';