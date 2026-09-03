'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend, errorMessage } from '@/lib/api';
import { PageHeader, Card, CardBody, Badge, Button, Modal, Field, Input, EmptyState, Alert, Spinner } from '@/components/ui';

interface Branch {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gps_radius_m: number;
  gps_accuracy_max_m: number;
  shift_grace_min: number;
  trip_threshold_min: number;
  is_active: boolean;
  day_start_hour: number;
  deleted_at: string | null;
  staff_count: number;
}

async function getCurrentPosition(timeoutMs = 10000): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation not available. Use HTTPS or localhost.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(new Error(err.message || 'Location capture failed')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export default function AdminBranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [removing, setRemoving] = useState<Branch | null>(null);
  const [adding, setAdding] = useState(false);
  const [locatingId, setLocatingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  // A branch with punches or trips behind it can never be deleted - payroll and
  // the attendance log both point at it, for every month it was ever open. So
  // Remove archives it, and the grid stops showing it by default: out of the
  // way is what is wanted, and out of the database would take the history with
  // it.
  const [showArchived, setShowArchived] = useState(false);

  async function load() {
    setLoading(true);
    const r = await apiGet<{ branches: Branch[] }>('/api/admin/branches');
    if (r.ok) setBranches(r.data.branches);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function recordLocation(b: Branch) {
    setMsg(null);
    setLocatingId(b.id);
    try {
      const fix = await getCurrentPosition();
      const res = await apiSend(`/api/admin/branches/${b.id}`, { method: 'PATCH', body: { lat: fix.lat, lng: fix.lng } });
      if (!res.ok) { setMsg({ tone: 'danger', text: errorMessage(res) }); return; }
      setMsg({ tone: 'success', text: `${b.name}: location saved at ±${Math.round(fix.accuracy)}m.` });
      await load();
    } catch (e) {
      setMsg({ tone: 'warning', text: e instanceof Error ? e.message : 'Location capture failed' });
    } finally {
      setLocatingId(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    const res = await apiSend<{ deleted: boolean; closed: boolean; staff_retired: number }>(`/api/admin/branches/${removing.id}`, { method: 'DELETE' });
    if (!res.ok) { setMsg({ tone: 'danger', text: errorMessage(res) }); setRemoving(null); return; }
    setMsg(
      res.data.closed
        ? {
            tone: 'warning',
            text:
              `${removing.name} is closed` +
              (res.data.staff_retired > 0
                ? `, and ${res.data.staff_retired} ${res.data.staff_retired === 1 ? 'account' : 'accounts'} went with it — those usernames are free again.`
                : '.') +
              ` The punches and trips made there stay, so payroll for the months it was open still adds up. From next month it will not appear anywhere.`,
          }
        : { tone: 'success', text: `${removing.name} removed.` },
    );
    setRemoving(null);
    await load();
  }

  return (
    <>
      <PageHeader
        title="Branches"
        subtitle="Create branches, set the geofence, and record each location on-site"
        actions={
          <div className="flex flex-wrap gap-2">
            {branches.some((b) => !b.is_active && !b.deleted_at) && (
              <Button size="sm" variant="secondary" onClick={() => setShowArchived((v) => !v)}>
                {showArchived
                  ? 'Hide archived'
                  : `Show archived (${branches.filter((b) => !b.is_active && !b.deleted_at).length})`}
              </Button>
            )}
            <Button onClick={() => setAdding(true)}>＋ Add branch</Button>
          </div>
        }
      />

      {msg && <div className="mb-3" data-testid="locate-message"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : branches.length === 0 ? (
        <EmptyState title="No branches yet" hint="Add your first branch, then record its location on-site." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {branches.filter((b) => !b.deleted_at && (showArchived || b.is_active)).map((b) => (
            <Card key={b.id}>
              <CardBody>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-semibold">{b.name}</h2>
                  <Badge tone={b.is_active ? 'success' : 'neutral'}>{b.is_active ? 'active' : 'archived'}</Badge>
                </div>

                <div className="mb-3 rounded-lg border border-border bg-surface-muted px-3 py-2.5">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">Location</div>
                  <div className="tabular mt-0.5 text-sm">
                    {b.lat === 0 && b.lng === 0 ? <span className="text-muted">Not set</span> : `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}`}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    onClick={() => recordLocation(b)}
                    loading={locatingId === b.id}
                    data-testid={`record-location-${b.id}`}
                  >
                    📍 Record location
                  </Button>
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  <Row k="Radius" v={`${b.gps_radius_m} m`} />
                  <Row k="Max accuracy" v={`${b.gps_accuracy_max_m} m`} />
                  <Row k="Shift grace" v={`${b.shift_grace_min} min`} />
                  <Row k="Trip threshold" v={`${b.trip_threshold_min} min`} />
                </dl>

                <div className="mt-4 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(b)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRemoving(b)}>Remove</Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {adding && <AddBranchModal onClose={() => setAdding(false)} onCreated={() => { setAdding(false); setMsg({ tone: 'success', text: 'Branch created. Record its location on-site next.' }); load(); }} />}
      {editing && <EditBranchModal branch={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setMsg({ tone: 'success', text: 'Branch updated.' }); load(); }} />}
      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}
          footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={confirmRemove}>Remove</Button></>}>
          <p className="text-sm text-muted">
            The branch closes now: nobody can punch there and it disappears from every screen and
            from the list you assign staff to.
          </p>
          {removing.staff_count > 0 && (
            <p className="mt-2 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm">
              <b>{removing.staff_count} {removing.staff_count === 1 ? 'account goes' : 'accounts go'} with it.</b>{' '}
              An account only works at a branch, so leaving them here would fail silently every
              morning. If anyone is moving to another branch, reassign them first and then come
              back.
            </p>
          )}
          <p className="mt-2 text-sm text-muted">
            The punches and trips made there <b className="text-content">stay</b>. Payroll for the
            months it was open still adds up; from next month it will not appear anywhere. A branch
            nothing ever happened at is deleted outright instead.
          </p>
        </Modal>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="tabular text-right font-medium">{v}</dd>
    </>
  );
}

function AddBranchModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await apiSend('/api/admin/branches', { body: { name } });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onCreated();
  }
  return (
    <Modal title="Add branch" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="add-branch" type="submit" loading={busy}>Create</Button></>}>
      <form id="add-branch" onSubmit={submit} className="space-y-4">
        <Field label="Branch name" htmlFor="bn" hint="You'll record the GPS location on-site after creating it.">
          <Input id="bn" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Downtown" />
        </Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}

function EditBranchModal({ branch, onClose, onSaved }: { branch: Branch; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: branch.name,
    gpsRadiusM: String(branch.gps_radius_m),
    gpsAccuracyMaxM: String(branch.gps_accuracy_max_m),
    shiftGraceMin: String(branch.shift_grace_min),
    tripThresholdMin: String(branch.trip_threshold_min),
    dayStartHour: String(branch.day_start_hour),
    isActive: branch.is_active,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await apiSend(`/api/admin/branches/${branch.id}`, {
      method: 'PATCH',
      body: {
        name: f.name,
        gpsRadiusM: parseInt(f.gpsRadiusM, 10),
        gpsAccuracyMaxM: parseInt(f.gpsAccuracyMaxM, 10),
        shiftGraceMin: parseInt(f.shiftGraceMin, 10),
        tripThresholdMin: parseInt(f.tripThresholdMin, 10),
        dayStartHour: parseInt(f.dayStartHour, 10),
        isActive: f.isActive,
      },
    });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onSaved();
  }
  return (
    <Modal title={`Edit ${branch.name}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="edit-branch" type="submit" loading={busy}>Save</Button></>}>
      <form id="edit-branch" onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="ebn"><Input id="ebn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Geofence radius (m)" htmlFor="er"><Input id="er" type="number" min="1" value={f.gpsRadiusM} onChange={(e) => setF({ ...f, gpsRadiusM: e.target.value })} /></Field>
          <Field label="Max accuracy (m)" htmlFor="ea"><Input id="ea" type="number" min="1" value={f.gpsAccuracyMaxM} onChange={(e) => setF({ ...f, gpsAccuracyMaxM: e.target.value })} /></Field>
          <Field label="Shift grace (min)" htmlFor="eg" hint="A day over or under its hours by less than this raises nothing - no overtime notice, no shortfall penalty."><Input id="eg" type="number" min="0" value={f.shiftGraceMin} onChange={(e) => setF({ ...f, shiftGraceMin: e.target.value })} /></Field>
          <Field label="Trip threshold (min)" htmlFor="et"><Input id="et" type="number" min="1" value={f.tripThresholdMin} onChange={(e) => setF({ ...f, tripThresholdMin: e.target.value })} /></Field>
          <Field
            label="Day starts at (hour)"
            htmlFor="ed"
            hint="0 = midnight. Raise it only if a shift here STARTS near midnight, so both sides of it count as one night."
          >
            <Input id="ed" type="number" min="0" max="12" value={f.dayStartHour} onChange={(e) => setF({ ...f, dayStartHour: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          Active
        </label>
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}
