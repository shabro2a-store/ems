'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';
import { Card, CardBody, CardHeader, Badge, Button, Spinner, Alert } from '@/components/ui';

interface BindState {
  code: string;
  expires_in_s: number;
  bound: boolean;
  bot_configured: boolean;
  webhook_secret_ok?: boolean;
  bind_url?: string | null;
}

interface TestResult {
  delivered: boolean;
  reason?: string;
  message?: string;
}

export function TelegramAlertsCard() {
  const [state, setState] = useState<BindState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState<'test' | 'disconnect' | null>(null);
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await apiGet<BindState>('/api/admin/telegram/code');
    if (res.ok) setState(res.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Codes roll every 10 minutes; refresh while the admin has it on screen.
  useEffect(() => {
    if (!showCode) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [showCode, load]);

  const sendTest = useCallback(async () => {
    setBusy('test');
    setBanner(null);
    const res = await apiSend<TestResult>('/api/admin/telegram/test');
    setBusy(null);
    if (!res.ok) {
      setBanner({ tone: 'danger', text: res.error.message });
      return;
    }
    setBanner(
      res.data.delivered
        ? { tone: 'success', text: 'Sent. Check the phone — if nothing arrived, the chat is bound to a different one.' }
        : { tone: 'danger', text: res.data.message ?? 'The test message was not delivered.' },
    );
    await load();
  }, [load]);

  const disconnect = useCallback(async () => {
    // The phone is company property in somebody else's pocket, so this is the
    // button you reach for when it goes missing. Confirm it, because pressing
    // it by accident silences every alert until somebody notices.
    if (!window.confirm('Stop sending alerts to the bound phone? You can bind it again at any time.')) return;
    setBusy('disconnect');
    setBanner(null);
    const res = await apiSend('/api/admin/telegram/disconnect');
    setBusy(null);
    setShowCode(false);
    if (!res.ok) {
      setBanner({ tone: 'danger', text: res.error.message });
      return;
    }
    setBanner({ tone: 'success', text: 'Disconnected. No alerts will reach that phone.' });
    await load();
  }, [load]);

  if (loading) {
    return (
      <Card>
        <CardHeader title="Telegram alerts" />
        <CardBody>
          <Spinner />
        </CardBody>
      </Card>
    );
  }
  if (!state) return null;

  return (
    <Card>
      <CardHeader
        title="Telegram alerts"
        subtitle={state.bound ? 'Alerts are delivered to a bound chat' : 'Not connected yet'}
      />
      <CardBody>
        {!state.bot_configured ? (
          <p className="text-sm text-muted">
            No bot token is configured on the server, so alerts stay in the app. Add{' '}
            <code className="rounded bg-surface-2 px-1">TELEGRAM_BOT_TOKEN</code> to the server
            environment to enable Telegram delivery.
          </p>
        ) : (
          <div className="space-y-3">
            {state.webhook_secret_ok === false && (
              <Alert tone="danger">
                <b>TELEGRAM_WEBHOOK_SECRET is still the default.</b> That value is published in this
                project&apos;s source, so anyone who knows it can post to the webhook and try codes at
                it. Alerts still work — this is worth fixing, not urgent. Put a fresh value in{' '}
                <code>.env</code> (<code>openssl rand -hex 16</code>), restart, then re-run{' '}
                <code>setWebhook</code> with the same value.
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={state.bound ? 'success' : 'warning'}>
                {state.bound ? 'Connected' : 'Not connected'}
              </Badge>
              {!showCode && (
                <Button size="sm" variant="secondary" onClick={() => setShowCode(true)}>
                  {state.bound ? 'Bind another chat' : 'Connect'}
                </Button>
              )}
              {state.bound && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === 'test'}
                    disabled={busy !== null}
                    onClick={() => void sendTest()}
                  >
                    Send test
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy === 'disconnect'}
                    disabled={busy !== null}
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>

            {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}

            {showCode && (
              <div className="space-y-2">
                {state.bind_url ? (
                  <>
                    <p className="text-sm">
                      Send this link to whoever holds the phone that should get the alerts. They tap
                      it once — Telegram opens and binds itself. They need no login here.
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
                        {state.bind_url}
                      </code>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void navigator.clipboard?.writeText(state.bind_url!).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          });
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <p className="text-sm text-muted">
                      Or, if they prefer to type it into the bot themselves:{' '}
                      <span className="tabular font-semibold text-content">/start {state.code}</span>
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm">Message the bot on Telegram and send this, code included:</p>
                    <div className="tabular rounded-md border border-border bg-surface-2 px-3 py-2 text-lg font-semibold tracking-widest">
                      /start {state.code}
                    </div>
                  </>
                )}
                <p className="text-xs text-muted">
                  Expires in {Math.max(0, Math.floor(state.expires_in_s / 60))}m{' '}
                  {state.expires_in_s % 60}s. Whoever uses it receives your alerts, so send it to the
                  work phone and nowhere else — you can undo it any time with Disconnect.
                </p>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
