import { Notifier, NotificationPayload } from './types';

// Lazily resolve the admin chat_id from DB. We don't import Prisma here
// to keep `notify` package framework-agnostic; the worker passes a lookup fn.
export interface TelegramNotifierOpts {
  botToken: string;
  webhookSecret: string;
  publicAppUrl: string;
  resolveRecipient: () => Promise<string | null>;
}

export class TelegramNotifier implements Notifier {
  constructor(private readonly opts: TelegramNotifierOpts) {}

  async send(payload: NotificationPayload): Promise<void> {
    if (payload.channel !== 'telegram') {
      // Unknown channel — drop silently. Real notifiers may throw.
      return;
    }
    const chatId = payload.recipient === 'admin'
      ? await this.opts.resolveRecipient()
      : payload.recipient;
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

export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  publicAppUrl: string,
): { text: string; deepLink?: string } {
  const c = context as Ctx;
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

    default:
      return {
        text: `[${template}] ${JSON.stringify(context).slice(0, 500)}`,
      };
  }
}