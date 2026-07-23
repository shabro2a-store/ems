import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { headers } from 'next/headers';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
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
  const provided = req.headers.get('x-telegram-bot-api-secret-token');
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && provided !== expected) {
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

  if (text === '/start') {
    // Bind the chat_id to the admin user. Single-admin system for now.
    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
    });
    if (!admin) {
      return jsonError('NOT_FOUND', 'No admin user found', 404);
    }
    await prisma.user.update({
      where: { id: admin.id },
      data: { telegram_chat_id: String(chatId) },
    });
    const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          `👋 Bound to admin <b>${admin.username}</b>.\n` +
          `You will now receive alerts for:\n` +
          `• Missed checkouts\n` +
          `• Trip over-threshold\n` +
          `• Driver stale (>4h OUT)\n` +
          `• End-of-day watch\n` +
          `• Advance requests\n` +
          `• Daily summary (23:00)\n\n` +
          `Reply /help for test commands.`,
        parse_mode: 'HTML',
      }),
    }).catch(() => null);
    return NextResponse.json({ ok: true, data: { bound: admin.id } });
  }

  // Other messages: silently ack so Telegram doesn't retry.
  return NextResponse.json({ ok: true, data: { skipped: true } });
}

export const dynamic = 'force-dynamic';