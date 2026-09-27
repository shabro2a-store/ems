import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTemplate, TelegramNotifier } from '../../../packages/notify/src/telegram';

/*
 * #36, the Telegram sender - fixed before the bot is switched on:
 *  - four kinds of alert had no template and went out as raw JSON;
 *  - names and messages went into HTML unescaped, so "Ali & Sons" or a "<"
 *    in a branch name made Telegram refuse the whole message;
 *  - a send had no timeout, and it runs inside the punch request;
 *  - the owner's two notification switches were saved and read by nothing.
 */
const APP = 'https://ems.example';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('every alert the system sends', () => {
  it.each(['punch.blocked', 'punch.auto_close', 'punch.second_working_day', 'punch.day_continues'])(
    '%s has a readable message, not raw JSON',
    (template) => {
      const { text } = renderTemplate(template, { user: { id: 'u', username: 'sami' }, message: 'sami is at Hamra.' }, APP);
      expect(text).not.toMatch(/^\[/);
      expect(text).not.toContain('{"');
      expect(text).toContain('sami is at Hamra.');
    },
  );

  it('escapes what goes into the HTML', () => {
    const { text } = renderTemplate(
      'advance_requested',
      { user: { id: 'u', username: '<b>Ali & Sons</b>' }, amount: 1000 },
      APP,
    );
    expect(text).toContain('&lt;b&gt;Ali &amp; Sons&lt;/b&gt;');
    expect(text).not.toContain('<b>Ali');
  });

  it('escapes a message built from names', () => {
    const { text } = renderTemplate('punch.blocked', { message: 'Rami <3 & co cannot clock in' }, APP);
    expect(text).toContain('Rami &lt;3 &amp; co cannot clock in');
  });
});

describe('sending', () => {
  const prefs = (over: Partial<{ dailySummary: boolean; routinePings: boolean }> = {}) => ({
    chatId: '42',
    dailySummary: true,
    routinePings: true,
    ...over,
  });

  function notifier(recipient: ReturnType<typeof prefs>, timeoutMs?: number) {
    return new TelegramNotifier({
      botToken: 'token',
      webhookSecret: 's',
      publicAppUrl: APP,
      resolveRecipient: async () => recipient,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  it('gives up on a Telegram that does not answer, instead of holding the punch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
          }),
      ),
    );
    const started = Date.now();
    await notifier(prefs(), 50).send({ channel: 'telegram', recipient: 'admin', template: 'missed_checkout', context: {} });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not send the daily summary when the owner switched it off', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier(prefs({ dailySummary: false }));
    await n.send({ channel: 'telegram', recipient: 'admin', template: 'daily_summary', context: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    await n.send({ channel: 'telegram', recipient: 'admin', template: 'missed_checkout', context: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send routine notices when the owner switched them off, but still sends what needs acting on', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier(prefs({ routinePings: false }));
    for (const template of ['watched_resolved', 'punch.day_continues', 'punch.second_working_day']) {
      await n.send({ channel: 'telegram', recipient: 'admin', template, context: {} });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await n.send({ channel: 'telegram', recipient: 'admin', template: 'punch.blocked', context: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
