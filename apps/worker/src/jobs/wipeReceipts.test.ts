import { describe, it, expect } from 'vitest';
import { runWipeReceipts, RECEIPT_KEEP_DAYS } from './wipeReceipts';

/*
 * Receipt photos have done their job once the owner has confirmed the day, and
 * the day confirms itself 48 hours after its last trip at the latest - so a
 * week on, every photo is dead weight. The trips keep receipt_taken_at as the
 * record that there was one.
 */
type Row = { trip_id: string; out_at: Date };

function makeDb(rows: Row[]) {
  return {
    tripReceipt: {
      deleteMany: async ({ where }: { where: { trip: { out_at: { lt: Date } } } }) => {
        const before = rows.length;
        const keep = rows.filter((r) => !(r.out_at < where.trip.out_at.lt));
        rows.length = 0;
        rows.push(...keep);
        return { count: before - keep.length };
      },
    },
  };
}

describe('runWipeReceipts', () => {
  it('deletes the photos of trips older than a week and keeps the rest', async () => {
    expect(RECEIPT_KEEP_DAYS).toBe(7);
    const now = new Date('2026-09-21T03:20:00Z');
    const rows: Row[] = [
      { trip_id: 'old', out_at: new Date('2026-09-13T10:00:00Z') }, // 7d 17h ago
      { trip_id: 'edge', out_at: new Date('2026-09-14T03:19:00Z') }, // a minute past a week
      { trip_id: 'fresh', out_at: new Date('2026-09-14T03:21:00Z') }, // a minute short of a week
      { trip_id: 'today', out_at: new Date('2026-09-21T01:00:00Z') },
    ];
    const r = await runWipeReceipts({ db: makeDb(rows) as never, now });
    expect(r.wiped).toBe(2);
    expect(rows.map((x) => x.trip_id)).toEqual(['fresh', 'today']);
  });
});
