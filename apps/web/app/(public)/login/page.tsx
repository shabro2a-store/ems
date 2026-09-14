'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiSend, errorMessage } from '@/lib/api';
import { Button, Field, Input, Alert } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The button is disabled in the HTML and enabled only once React is running.
  // A browser that cannot run the page's script - JavaScript off, or a Chrome
  // too old for the bundle - used to submit the form natively and land back
  // on this page, which read as "login keeps reloading". Now it shows a
  // button that never wakes up, and the note under it says why.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await apiSend<{ user?: { role: string } }>('/api/auth/login', {
      body: { username, password },
    });
    setLoading(false);
    if (!res.ok) {
      setError(errorMessage(res));
      return;
    }
    const role = res.data.user?.role;
    if (role === 'ADMIN') router.push('/admin');
    else if (role === 'DRIVER') router.push('/driver');
    else if (role === 'CALLER') router.push('/caller');
    else router.push('/employee');
  }

  return (
    <main className="grid min-h-screen place-items-center bg-bg p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-8">
          <BrandMark size="lg" subtitle="Employee Management" />
        </h1>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-card"
        >
          <Field label="Username" htmlFor="username">
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" size="lg" fullWidth loading={loading} disabled={!ready}>
            {loading ? 'Signing in…' : ready ? 'Sign in' : 'Loading…'}
          </Button>
          {!ready && (
            <p className="text-center text-xs text-muted">
              If this stays on Loading, your browser cannot run the app: update Chrome from the Play Store, or open
              this address in another browser.
            </p>
          )}
          <noscript>
            <p className="text-center text-xs text-danger">JavaScript is turned off in this browser. Turn it on for this site to sign in.</p>
          </noscript>
        </form>
      </div>
    </main>
  );
}
