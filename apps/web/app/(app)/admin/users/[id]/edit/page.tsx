'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface User {
  id: string;
  username: string;
  role: string;
  notify_daily_summary: boolean;
  notify_routine_pings: boolean;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

export default function NotificationPrefsPage() {
  const params = useParams();
  const userId = params.id as string;
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string>('');
  const [dailySummary, setDailySummary] = useState(false);
  const [routinePings, setRoutinePings] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/me/ping', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) setUsername(j.data.userId ?? '');
    }).catch(() => {});
    fetch('/api/admin/users', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) {
        const u = j.data.users.find((u: User) => u.id === userId);
        if (u) {
          setUser(u);
          setDailySummary(u.notify_daily_summary);
          setRoutinePings(u.notify_routine_pings);
        }
      }
    }).catch(() => {});
  }, [userId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setErr(null);
    setSaved(false);
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/users/${user.id}/notification-prefs`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({
          dailySummary,
          routinePings,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <>
        <main className="p-4">Loading…</main>
      </>
    );
  }

  return (
    <>
      <main className="p-4 max-w-md mx-auto">
        <h1 className="text-xl font-semibold mb-1">Notification prefs</h1>
        <p className="text-sm text-gray-600 mb-4">{user.username} ({user.role})</p>

        {saved && <div className="mb-3 text-green-600 text-sm">Saved.</div>}
        {err && <div className="mb-3 text-red-600 text-sm">{err}</div>}

        <form onSubmit={save} className="space-y-4">
          <div className="rounded border bg-white p-4 space-y-3">
            <p className="text-sm text-gray-700">
              These settings control Telegram notifications sent to this admin user.
              Exception events always fire regardless of these toggles.
            </p>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={dailySummary}
                onChange={(e) => setDailySummary(e.target.checked)}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-sm">Daily summary</div>
                <div className="text-xs text-gray-600">Receive a summary at 11pm Beirut each day.</div>
              </div>
            </label>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={routinePings}
                onChange={(e) => setRoutinePings(e.target.checked)}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-sm">Routine pings</div>
                <div className="text-xs text-gray-600">
                  Receive pings when employees punch in on time.
                  Suppressed if off; exceptions (late, missed, watched) always fire.
                </div>
              </div>
            </label>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full min-h-[56px] rounded bg-blue-600 text-white text-base disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </main>
    </>
  );
}