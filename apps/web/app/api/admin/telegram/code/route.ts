import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { currentBindCode } from '@/lib/services/telegramBind';

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET() {
  const h = headers();
  const userId = h.get('x-user-id');
  const role = h.get('x-user-role');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const admin = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, telegram_chat_id: true },
  });
  if (!admin) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const configured = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const { code, expiresInSec } = currentBindCode(admin.id);

  return NextResponse.json({
    ok: true,
    data: {
      code,
      expires_in_s: expiresInSec,
      bound: Boolean(admin.telegram_chat_id),
      bot_configured: configured,
    },
  });
}

export const dynamic = 'force-dynamic';
