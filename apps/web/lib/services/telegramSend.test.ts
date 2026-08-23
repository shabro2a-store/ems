import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import { boundAdminChatId, sendToChat } from './telegramSend';

type AdminRow = { id: string; role: string; telegram_chat_id: string | null; created_at: Date };

function fakeDb(rows: AdminRow[]) {
  return {
    user: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: { role: string; telegram_chat_id?: { not: null } };
        orderBy?: { created_at: 'asc' | 'desc' };
      }) => {
        const matched = rows
          .filter((r) => r.role === where.role)
          .filter((r) => (where.telegram_chat_id ? r.telegram_chat_id !== null : true))
          .sort((a, b) =>
            orderBy?.created_at === 'desc'
              ? b.created_at.getTime() - a.created_at.getTime()
              : a.created_at.getTime() - b.created_at.getTime(),
          );
        return matched[0] ?? null;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const admin = (id: string, chat: string | null, day: number): AdminRow => ({
  id,
  role: 'ADMIN',
  telegram_chat_id: chat,
  created_at: new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`),
});

describe('boundAdminChatId', () => {
  it('returns null when nobody has bound a phone', async () => {
    expect(await boundAdminChatId(fakeDb([admin('a', null, 1)]))).toBeNull();
  });

  it('never lets an unbound admin shadow a bound one', async () => {
    // The regression this exists for: an unordered findFirst over the admins
    // could return the account that never bound a phone, whose chat_id is null,
    // and every alert in the system would then be dropped with one console line
    // nobody reads. The older account here is the unbound one on purpose.
    const chat = await boundAdminChatId(fakeDb([admin('older', null, 1), admin('newer', '555', 2)]));
    expect(chat).toBe('555');
  });

  it('is deterministic when two admins are both bound', async () => {
    const rows = [admin('older', '111', 1), admin('newer', '222', 2)];
    expect(await boundAdminChatId(fakeDb(rows))).toBe('111');
    expect(await boundAdminChatId(fakeDb([...rows].reverse()))).toBe('111');
  });

  it('ignores non-admins', async () => {
    const rows = [{ ...admin('e', '999', 1), role: 'EMPLOYEE' }];
    expect(await boundAdminChatId(fakeDb(rows))).toBeNull();
  });
});

describe('sendToChat', () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-1234567890';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = realToken;
  });

  it('reports a missing token instead of pretending to send', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = await sendToChat('1', 'hi');
    expect(r).toEqual({ ok: false, reason: 'NO_TOKEN' });
  });

  it('surfaces Telegram own description, which names the fix', async () => {
    // "chat not found", "bot was blocked by the user" and "Unauthorized" each
    // send the owner somewhere different. Collapsing them to "failed" does not.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
        status: 400,
      }),
    ) as unknown as typeof fetch;

    const r = await sendToChat('1', 'hi');
    expect(r).toEqual({ ok: false, reason: 'TELEGRAM_ERROR', detail: 'Bad Request: chat not found' });
  });

  it('does not throw when the network is down', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
    }) as unknown as typeof fetch;

    const r = await sendToChat('1', 'hi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TELEGRAM_ERROR');
  });

  it('reports success on a 200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    expect(await sendToChat('1', 'hi')).toEqual({ ok: true });
  });
});
