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

  // The webhook secret is what proves an update really came from Telegram.
  // docker-compose falls back to a literal that is committed to this repo, so
  // "unset" looks identical to "set" from the outside and nothing would ever
  // fail - the owner has to be shown it, or he will never find out.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const webhookSecretOk = secret.length > 0 && secret !== 'dev_webhook_secret_change_in_prod';

  return NextResponse.json({
    ok: true,
    data: {
      code,
      expires_in_s: expiresInSec,
      bound: Boolean(admin.telegram_chat_id),
      bot_configured: configured,
      webhook_secret_ok: webhookSecretOk,
    },
  });
}

export const dynamic = 'force-dynamic';
