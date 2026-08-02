'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { Card, CardBody, CardHeader, Badge, Button, Spinner } from '@/components/ui';

interface BindState {
  code: string;
  expires_in_s: number;
  bound: boolean;
  bot_configured: boolean;
}

export function TelegramAlertsCard() {
  const [state, setState] = useState<BindState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCode, setShowCode] = useState(false);

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
            <div className="flex items-center gap-2">
              <Badge tone={state.bound ? 'success' : 'warning'}>
                {state.bound ? 'Connected' : 'Not connected'}
              </Badge>
              {!showCode && (
                <Button size="sm" variant="secondary" onClick={() => setShowCode(true)}>
                  {state.bound ? 'Bind another chat' : 'Connect'}
                </Button>
              )}
            </div>

            {showCode && (
              <div className="space-y-2">
                <p className="text-sm">
                  Message the bot on Telegram and send this, code included:
                </p>
                <div className="tabular rounded-md border border-border bg-surface-2 px-3 py-2 text-lg font-semibold tracking-widest">
                  /start {state.code}
                </div>
                <p className="text-xs text-muted">
                  Expires in {Math.max(0, Math.floor(state.expires_in_s / 60))}m{' '}
                  {state.expires_in_s % 60}s. Anyone with this code can receive your alerts — do not
                  share it.
                </p>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
