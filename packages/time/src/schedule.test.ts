import { describe, it, expect } from 'vitest';
import { scheduleRowOn } from './index';

/*
 * The weekly hours had no history: an edit deleted the old rows and wrote new
 * ones, and every past day - paid months included - was judged against the
 * new hours from then on. Raising Monday from 8h to 9h in October docked every
 * September Monday an hour, in a month that could no longer be waived.
 */
const row = (weekday: number, shift_min: number, from: string) => ({ weekday, shift_min, effective_from: new Date(`${from}T00:00:00.000Z`) });
const rows = [row(1, 480, '1970-01-01'), row(1, 540, '2026-10-05'), row(2, 480, '1970-01-01'), row(2, 0, '2026-10-05')];

describe('the weekly hours in force on a date', () => {
  it('is the row that had taken effect by then, not the latest one', () => {
    expect(scheduleRowOn(rows, '2026-09-07')?.shift_min).toBe(480); // a Monday before the change
    expect(scheduleRowOn(rows, '2026-10-12')?.shift_min).toBe(540); // a Monday after it
  });

  it('takes effect on the day it names', () => {
    expect(scheduleRowOn(rows, '2026-10-05')?.shift_min).toBe(540);
  });

  it('keeps a day turned off as off from then on', () => {
    expect(scheduleRowOn(rows, '2026-09-08')?.shift_min).toBe(480); // Tuesday before
    expect(scheduleRowOn(rows, '2026-10-06')?.shift_min).toBe(0); // Tuesday after
  });

  it('has nothing for a weekday never scheduled', () => {
    expect(scheduleRowOn(rows, '2026-10-07')).toBeUndefined(); // a Wednesday
  });
});

describe('the whole week in force on a date', () => {
  it('has one row per scheduled weekday, including a change made that day', async () => {
    const { weekInForce } = await import('./index');
    const week = weekInForce(rows, '2026-10-05');
    expect(week.map((r) => [r.weekday, r.shift_min])).toEqual([[1, 540], [2, 0]]);
    expect(weekInForce(rows, '2026-10-04').map((r) => [r.weekday, r.shift_min])).toEqual([[1, 480], [2, 480]]);
  });
});
