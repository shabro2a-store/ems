import { Notifier, NotificationPayload } from './types';

// Lazily resolve the admin chat_id from DB. We don't import Prisma here
// to keep `notify` package framework-agnostic; the worker passes a lookup fn.
/** Where the owner's alerts go, and the two switches he has over them. */
export interface AdminRecipient {
  chatId: string;
  dailySummary: boolean;
  routinePings: boolean;
}

export interface TelegramNotifierOpts {
  botToken: string;
  webhookSecret: string;
  publicAppUrl: string;
  resolveRecipient: () => Promise<AdminRecipient | null>;
  /** How long one send may take. Sends run inside the punch request. */
  timeoutMs?: number;
}

/**
 * How long a send may hold the request it runs in. A punch alert is sent from
 * inside the punch, so a Telegram that hangs would hang the employee's
 * check-in with it.
 */
export const TELEGRAM_TIMEOUT_MS = 5_000;

/**
 * Notices that need nothing done - "routine pings", which the owner can switch
 * off. Anything that needs a decision or a look (a missed checkout, somebody
 * stuck at the door, a closed shift, an advance to approve) always goes.
 */
export const ROUTINE_TEMPLATES = new Set(['watched_resolved', 'punch.day_continues', 'punch.second_working_day']);

export class TelegramNotifier implements Notifier {
  constructor(private readonly opts: TelegramNotifierOpts) {}

  async send(payload: NotificationPayload): Promise<void> {
    if (payload.channel !== 'telegram') {
      // Unknown channel — drop silently. Real notifiers may throw.
      return;
    }
    let chatId: string | null;
    if (payload.recipient === 'admin') {
      const admin = await this.opts.resolveRecipient();
      if (admin && payload.template === 'daily_summary' && !admin.dailySummary) return;
      if (admin && ROUTINE_TEMPLATES.has(payload.template) && !admin.routinePings) return;
      chatId = admin?.chatId ?? null;
    } else {
      chatId = payload.recipient;
    }
    if (!chatId) {
      console.warn(`[TelegramNotifier] no chat_id for recipient=${payload.recipient}`);
      return;
    }
    const { text, deepLink } = renderTemplate(payload.template, payload.context, this.opts.publicAppUrl);
    const url = `https://api.telegram.org/bot${this.opts.botToken}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(deepLink ? { reply_markup: { inline_keyboard: [[{ text: 'Open', url: deepLink }]] } } : {}),
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? TELEGRAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[TelegramNotifier] send failed ${res.status}: ${errBody.slice(0, 200)}`);
      }
    } catch (e) {
      console.error('[TelegramNotifier] fetch failed', e instanceof Error ? e.message : e);
    }
  }
}

// Pure template functions. Async so we can format times via the `time` package
// without coupling this package to it. We accept ISO strings in context.
interface Ctx {
  user?: { id: string; username: string };
  driver?: { id: string; username: string };
  branch?: { id: string; name: string } | null;
  flag_id?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  since_min?: number;
  since_hours?: number;
  minutes?: number;
  threshold_min?: number;
  present?: number;
  absent?: number;
  drivers_out?: number;
  flags_count?: number;
  message?: string;
  amount?: number;
  deepLink?: string;
  date?: string;
}

/** Text for Telegram's HTML mode: a name with "&" or "<" otherwise makes it refuse the message. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeContext(value: unknown): unknown {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map(escapeContext);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, escapeContext(v)]));
  }
  return value;
}

export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  publicAppUrl: string,
): { text: string; deepLink?: string } {
  // Every value from the context is escaped once, here; the markup around it
  // is the template's own. deepLink and flag_id only ever go into URLs.
  const raw = context as Ctx;
  const c = { ...(escapeContext(context) as Ctx), deepLink: raw.deepLink, flag_id: raw.flag_id };
  const deepLinkSuffix = c.deepLink ?? (c.flag_id ? `?focus=${c.flag_id}` : '');

  switch (template) {
    case 'missed_checkout':
      return {
        text: `⚠️ <b>Missed checkout</b>\n${c.message ?? `Employee ${c.user?.username} still clocked in past shift end`}\n\nClick below to review.`,
        deepLink: `${publicAppUrl}/admin/punches${deepLinkSuffix}`,
      };

    case 'trip.over_threshold': {
      const m = c.minutes ?? 0;
      const t = c.threshold_min ?? 30;
      const sinceMin = c.since_min ?? m;
      return {
        text: `🚚 <b>Driver over trip threshold</b>\n${c.user?.username ?? c.driver?.username ?? 'A driver'} out ${sinceMin} min and counting (threshold: ${t} min).`,
        deepLink: `${publicAppUrl}/admin`,
      };
    }

    case 'driver.stale': {
      const hours = Math.floor((c.since_hours ?? (c.minutes ?? 0) / 60));
      return {
        text: `🚨 <b>Driver out too long</b>\n${c.user?.username ?? c.driver?.username ?? 'Driver'} marked OUT for ${hours}+h, no BACK press. Phone dead or stranded?`,
        deepLink: `${publicAppUrl}/admin`,
      };
    }

    case 'end_of_day_watched': {
      return {
        text: `📋 <b>End-of-day watch</b>\n${c.user?.username ?? 'Employee'} never punched in today (flagged since ${c.scheduled_start ?? 'morning'}).`,
        deepLink: `${publicAppUrl}/admin${deepLinkSuffix}`,
      };
    }

    case 'watched_resolved': {
      return {
        text: `✅ <b>Watched user punched</b>\n${c.message ?? `${c.user?.username} punched in/out after being flagged.`}`,
        deepLink: `${publicAppUrl}/admin${deepLinkSuffix}`,
      };
    }

    case 'watched.unresolved': {
      return {
        text: `⚠️ <b>Watched flag never resolved</b>\n${c.message ?? `${c.user?.username ?? 'Employee'} never punched in today`}`,
        deepLink: `${publicAppUrl}/admin${deepLinkSuffix}`,
      };
    }

    case 'advance_requested': {
      const amount = ((c.amount ?? 0) / 100).toFixed(2);
      return {
        text: `💰 <b>Advance requested</b>\n${c.user?.username ?? 'Employee'} requested $${amount}.\n\nApprove or reject it in Needs attention.`,
        deepLink: `${publicAppUrl}/admin${deepLinkSuffix}`,
      };
    }

    case 'daily_summary': {
      const branchName = c.branch?.name ?? 'All branches';
      return {
        text:
          `📊 <b>Daily summary — ${branchName}</b>\n` +
          `Present: ${c.present ?? 0}\n` +
          `Absent: ${c.absent ?? 0}\n` +
          `Drivers out: ${c.drivers_out ?? 0}\n` +
          `Flags: ${c.flags_count ?? 0}`,
        deepLink: `${publicAppUrl}/admin`,
      };
    }

    case 'punch.blocked':
      return {
        text: `⛔ <b>Stuck at the door</b>\n${c.message ?? `${c.user?.username ?? 'An employee'} cannot clock in.`}`,
        deepLink: `${publicAppUrl}/admin`,
      };

    case 'punch.auto_close':
      return {
        text: `🔒 <b>Shift closed by the system</b>\n${c.message ?? `${c.user?.username ?? 'An employee'} never punched out.`}`,
        deepLink: `${publicAppUrl}/admin/punches`,
      };

    case 'punch.second_working_day':
      return {
        text: `🔁 <b>Second shift today</b>\n${c.message ?? `${c.user?.username ?? 'An employee'} clocked in again.`}`,
        deepLink: `${publicAppUrl}/admin/punches`,
      };

    case 'punch.day_continues':
      return {
        text: `↩️ <b>Back from a break</b>\n${c.message ?? `${c.user?.username ?? 'An employee'} clocked in again.`}`,
        deepLink: `${publicAppUrl}/admin/punches`,
      };

    case 'backup.stale':
      return {
        text: `<b>Backup missing</b>\n${c.message ?? 'No successful backup in the last day.'}`,
        deepLink: `${publicAppUrl}/admin`,
      };

    default:
      // Never raw JSON: an alert nobody wrote a template for still reads as a sentence.
      return {
        text: `🔔 <b>${escapeHtml(template)}</b>${c.message ? `\n${c.message}` : ''}`,
        deepLink: `${publicAppUrl}/admin`,
      };
  }
}