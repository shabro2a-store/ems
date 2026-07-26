'use client';

import { useState } from 'react';
import { apiSend, errorMessage } from '@/lib/api';
import { Modal, Field, Input, Button, Alert } from '@/components/ui';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (next.length < 6) { setErr('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setErr('The new passwords do not match.'); return; }
    setBusy(true);
    const res = await apiSend('/api/me/password', { body: { currentPassword: current, newPassword: next } });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    setDone(true);
  }

  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={done
        ? <Button onClick={onClose}>Done</Button>
        : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="change-pw" type="submit" loading={busy}>Update password</Button></>}
    >
      {done ? (
        <Alert tone="success">Your password has been changed.</Alert>
      ) : (
        <form id="change-pw" onSubmit={submit} className="space-y-4">
          <Field label="Current password" htmlFor="cpw"><Input id="cpw" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required /></Field>
          <Field label="New password" htmlFor="npw"><Input id="npw" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required /></Field>
          <Field label="Confirm new password" htmlFor="npw2"><Input id="npw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></Field>
          {err && <Alert tone="danger">{err}</Alert>}
        </form>
      )}
    </Modal>
  );
}
