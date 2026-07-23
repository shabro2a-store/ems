'use client';

import { useEffect, useState } from 'react';
import AdminNav from '@/components/admin/AdminNav';

interface Branch {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gps_radius_m: number;
  gps_accuracy_max_m: number;
  absent_grace_min: number;
  trip_threshold_min: number;
  is_active: boolean;
}

interface EditState {
  id: string;
  name: string;
  lat: string;
  lng: string;
  gps_radius_m: string;
  gps_accuracy_max_m: string;
  absent_grace_min: string;
  trip_threshold_min: string;
  is_active: boolean;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toEditable(b: Branch): EditState {
  return {
    id: b.id,
    name: b.name,
    lat: String(b.lat),
    lng: String(b.lng),
    gps_radius_m: String(b.gps_radius_m),
    gps_accuracy_max_m: String(b.gps_accuracy_max_m),
    absent_grace_min: String(b.absent_grace_min),
    trip_threshold_min: String(b.trip_threshold_min),
    is_active: b.is_active,
  };
}

async function getCurrentPosition(timeoutMs = 10000): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation not available in this browser. Use HTTPS or localhost.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(new Error(err.message || 'Location capture failed')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

export default function AdminBranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [username, setUsername] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [locatingId, setLocatingId] = useState<string | null>(null);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const [lastFix, setLastFix] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);

  async function load() {
    const res = await fetch('/api/admin/branches', { credentials: 'include' });
    const body = await res.json();
    if (body.ok) setBranches(body.data.branches);
  }

  useEffect(() => {
    fetch('/api/me/ping', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) setUsername(j.data.userId ?? '');
    }).catch(() => {});
    load();
  }, []);

  function startEdit(b: Branch) {
    setEditing(toEditable(b));
    setErr(null);
    setSaved(false);
  }

  async function recordLocation(b: Branch) {
    setErr(null);
    setLocateMsg(null);
    setLocatingId(b.id);
    try {
      const fix = await getCurrentPosition();
      setLastFix(fix);
      // Auto-open the edit form with the captured coords filled in
      setEditing({
        id: b.id,
        name: b.name,
        lat: fix.lat.toFixed(6),
        lng: fix.lng.toFixed(6),
        gps_radius_m: String(b.gps_radius_m),
        gps_accuracy_max_m: String(b.gps_accuracy_max_m),
        absent_grace_min: String(b.absent_grace_min),
        trip_threshold_min: String(b.trip_threshold_min),
        is_active: b.is_active,
      });
      setSaved(false);
      setLocateMsg(`Captured at ±${Math.round(fix.accuracy)}m accuracy. Review and click Save.`);
    } catch (e) {
      setLocateMsg(e instanceof Error ? e.message : 'Location capture failed');
    } finally {
      setLocatingId(null);
    }
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const r = await fetch(`/api/admin/branches/${editing.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfFromCookie() ?? '',
          'Idempotency-Key': idemKey(),
        },
        body: JSON.stringify({
          lat: parseFloat(editing.lat),
          lng: parseFloat(editing.lng),
          gpsRadiusM: parseInt(editing.gps_radius_m),
          gpsAccuracyMaxM: parseInt(editing.gps_accuracy_max_m),
          absentGraceMin: parseInt(editing.absent_grace_min),
          tripThresholdMin: parseInt(editing.trip_threshold_min),
          isActive: editing.is_active,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      setEditing(null);
      setSaved(true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AdminNav username={username || 'admin'} flagCount={0} />
      <main className="p-4 max-w-5xl mx-auto">
        <h1 className="text-xl font-semibold mb-4">Branches</h1>
        {locateMsg && (
          <div
            data-testid="locate-message"
            className={`mb-3 text-sm rounded px-3 py-2 ${
              locateMsg.startsWith('Captured')
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-amber-50 text-amber-800'
            }`}
          >
            {locateMsg}
          </div>
        )}
        {err && <div className="mb-3 text-red-600 text-sm">{err}</div>}
        {saved && <div className="mb-3 text-green-600 text-sm">Saved.</div>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {branches.map((b) => {
            const isEditing = editing?.id === b.id;
            return (
              <div key={b.id} className="rounded border border-gray-200 bg-white p-4">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-semibold">{b.name}</h2>
                  <span className={`text-xs rounded px-2 py-1 ${b.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                    {b.is_active ? 'active' : 'inactive'}
                  </span>
                </div>
                <dl className="text-sm space-y-1">
                  <div className="flex gap-2">
                    <dt className="text-gray-600">Coords:</dt>
                    <dd>{b.lat.toFixed(5)}, {b.lng.toFixed(5)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-gray-600">Radius:</dt>
                    <dd>{b.gps_radius_m}m</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-gray-600">Max accuracy:</dt>
                    <dd>{b.gps_accuracy_max_m}m</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-gray-600">Grace:</dt>
                    <dd>{b.absent_grace_min} min</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-gray-600">Trip threshold:</dt>
                    <dd>{b.trip_threshold_min} min</dd>
                  </div>
                </dl>
                {!isEditing ? (
                  <div className="mt-3 space-y-2">
                    <button
                      onClick={() => startEdit(b)}
                      className="w-full min-h-[56px] rounded bg-blue-600 text-white text-base"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => recordLocation(b)}
                      disabled={locatingId === b.id}
                      data-testid={`record-location-${b.id}`}
                      className="w-full min-h-[56px] rounded bg-emerald-600 text-white text-base disabled:opacity-50"
                    >
                      {locatingId === b.id ? 'Capturing GPS…' : '📍 Record Location'}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <label className="block">
                      <span className="text-xs text-gray-600">Lat</span>
                      <input
                        type="number"
                        step="0.00001"
                        value={editing.lat}
                        onChange={(e) => setEditing({ ...editing, lat: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-600">Lng</span>
                      <input
                        type="number"
                        step="0.00001"
                        value={editing.lng}
                        onChange={(e) => setEditing({ ...editing, lng: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-600">Radius (m)</span>
                      <input
                        type="number"
                        min="1"
                        value={editing.gps_radius_m}
                        onChange={(e) => setEditing({ ...editing, gps_radius_m: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-600">Max accuracy (m)</span>
                      <input
                        type="number"
                        min="1"
                        value={editing.gps_accuracy_max_m}
                        onChange={(e) => setEditing({ ...editing, gps_accuracy_max_m: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-600">Grace (min)</span>
                      <input
                        type="number"
                        min="0"
                        value={editing.absent_grace_min}
                        onChange={(e) => setEditing({ ...editing, absent_grace_min: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-600">Trip threshold (min)</span>
                      <input
                        type="number"
                        min="1"
                        value={editing.trip_threshold_min}
                        onChange={(e) => setEditing({ ...editing, trip_threshold_min: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={editing.is_active}
                        onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })}
                      />
                      <span className="text-sm">Active</span>
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditing(null)}
                        className="flex-1 min-h-[44px] rounded bg-gray-200 text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={save}
                        disabled={busy}
                        className="flex-1 min-h-[44px] rounded bg-blue-600 text-white text-sm disabled:opacity-50"
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}