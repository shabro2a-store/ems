import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { sendToChat } from '@/lib/services/telegramSend';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * Stop delivering alerts to the bound phone.
 *
 * The handset is company property carried by a member of staff. Re-binding from
 * a second phone was the only way to move the feed, and that needs a second
 * phone; there was no way at all to simply turn it off when the handset is
 * lost, stolen, or walks out with somebody.
 *
 * Clears EVERY admin binding, not just the row of whoever pressed it. The
 * button promises that alerts stop, and with two admin accounts clearing only
 * the caller's could leave the notifier resolving the other one and the feed
 * running - a disconnect that does not disconnect is the worst outcome
 * available here. There is one work phone; if a second is ever bound, rebinding
 * it costs one code.
 */
export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  const role = h.get('x-user-role');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  const bound = await prisma.user.findMany({
    where: { role: 'ADMIN', telegram_chat_id: { not: null } },
    select: { id: true, telegram_chat_id: true },
  });
  if (bound.length === 0) {
    return NextResponse.json({ ok: true, data: { was_bound: false, cleared: 0 } });
  }

  await prisma.user.updateMany({
    where: { role: 'ADMIN', telegram_chat_id: { not: null } },
    data: { telegram_chat_id: null },
  });

  for (const b of bound) {
    await writeAuditLog({
      actorId: userId,
      action: 'telegram.disconnect',
      entity: 'User',
      entityId: b.id,
      before: { telegram_chat_id: b.telegram_chat_id },
      after: { telegram_chat_id: null },
    });
  }

  // Best-effort, and after the unbind rather than before: whether the handset
  // is reachable must not decide whether it keeps receiving the alerts. If it
  // is somebody else's phone by now, this is also how they learn it was cut off.
  const chats = [...new Set(bound.map((b) => b.telegram_chat_id!))];
  await Promise.all(
    chats.map((c) =>
      sendToChat(
        c,
        '\u{1F50C} <b>Disconnected</b>\nThis chat no longer receives Shabro2a EMS alerts. ' +
          'Bind again from the app if this was not intended.',
      ),
    ),
  );

  return NextResponse.json({ ok: true, data: { was_bound: true, cleared: bound.length } });
}

export const dynamic = 'force-dynamic';
