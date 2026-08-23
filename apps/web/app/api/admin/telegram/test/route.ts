import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { boundAdminChatId, sendToChat } from '@/lib/services/telegramSend';

// Each failure names the thing to go and fix. "Test failed" would send the
// owner back to a checklist of two env vars and a webhook with no way to tell
// which of them is wrong.
const REASON_MESSAGE: Record<string, string> = {
  NO_TOKEN:
    'No bot token on the server. Add TELEGRAM_BOT_TOKEN to .env, restart the containers, then try again.',
  NOT_BOUND:
    'No chat is bound yet. Press Connect and send the code from the phone that should receive the alerts.',
};

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * Prove the whole delivery chain, on demand.
 *
 * `bot_configured` says a token exists and `bound` says a chat id is stored -
 * neither says a message can actually be delivered. A token typed one
 * character short, a bot the manager later blocked, a chat lost by reinstalling
 * Telegram: all three read as connected and deliver nothing, and the first
 * anyone would know is a missing alert about something that mattered.
 *
 * Sends to boundAdminChatId - the chat the notifier itself resolves - and not
 * to the logged-in admin's own row. A test that proves a different chat works
 * is worse than no test.
 */
export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  const role = h.get('x-user-role');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  const chatId = await boundAdminChatId();
  if (!chatId) {
    return NextResponse.json({
      ok: true,
      data: { delivered: false, reason: 'NOT_BOUND', message: REASON_MESSAGE.NOT_BOUND },
    });
  }

  const result = await sendToChat(
    chatId,
    '✅ <b>Test alert</b>\nAlerts are reaching this phone. Nothing is wrong — ' +
      'somebody pressed the test button in the app.',
  );

  if (result.ok) {
    return NextResponse.json({ ok: true, data: { delivered: true } });
  }

  return NextResponse.json({
    ok: true,
    data: {
      delivered: false,
      reason: result.reason,
      message:
        REASON_MESSAGE[result.reason] ??
        `Telegram refused the message: ${result.detail ?? 'unknown error'}.`,
    },
  });
}

export const dynamic = 'force-dynamic';
