import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestUser } from '../test-helpers/db';
import { POST } from '@/app/api/telegram/webhook/route';

/*
 * Security #6, the Telegram webhook:
 *  - before a bot token was set, the secret check was skipped and /start bound
 *    whoever sent it first - so the stranger, not the owner, got the alerts
 *    from the day the bot was switched on;
 *  - docker-compose.yml filled in a published fallback secret when none was
 *    set, which is no secret at all;
 *  - /start and /stop changed where the alerts go and left no audit trail.
 */
const COMPOSE_FALLBACK = 'dev_webhook_secret_change_in_prod';

function update(text: string, secret?: string) {
  return new Request('http://127.0.0.1/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 4242 }, text, date: 0 } }),
  });
}

describe('the Telegram webhook', () => {
  let adminId: string;

  beforeEach(async () => {
    await cleanDb();
    adminId = (await seedTestUser({ username: 'tg-owner', role: Role.ADMIN })).id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  const boundChat = async () =>
    (await getTestPrisma().user.findUnique({ where: { id: adminId }, select: { telegram_chat_id: true } }))!.telegram_chat_id;

  it('binds nothing before a bot is set up', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    await POST(update('/start'));
    expect(await boundChat()).toBeNull();
  });

  it('refuses the fallback secret docker-compose.yml used to fill in', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', COMPOSE_FALLBACK);
    const res = await POST(update('/start', COMPOSE_FALLBACK));
    expect(res.status).toBe(403);
    expect(await boundChat()).toBeNull();
  });

  it('records /start and /stop in the audit log', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'a-real-secret-0123456789');
    await POST(update('/start', 'a-real-secret-0123456789'));
    expect(await boundChat()).toBe('4242');
    await POST(update('/stop', 'a-real-secret-0123456789'));
    expect(await boundChat()).toBeNull();

    const actions = (await getTestPrisma().auditLog.findMany({ orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['telegram.bind', 'telegram.unbind']);
  });
});
