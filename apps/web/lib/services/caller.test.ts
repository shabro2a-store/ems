import { describe, it, expect } from 'vitest';
import { compareForRotation, type DriverStatus } from './caller';

function driver(over: Partial<DriverStatus> & { name: string }): DriverStatus {
  return {
    id: over.name,
    username: over.name,
    clocked_in: true,
    available: true,
    open_trip_since: null,
    trips_today: 0,
    ringing: false,
    last_trip_at: null,
    ...over,
  };
}

const order = (ds: DriverStatus[]) => [...ds].sort(compareForRotation).map((d) => d.name);

describe('caller board rotation', () => {
  it('keeps never-dispatched drivers ahead of anyone who has been out', () => {
    const board = [
      driver({ name: '2', last_trip_at: '2026-08-02T10:00:00.000Z' }),
      driver({ name: '1' }),
      driver({ name: '3' }),
    ];
    expect(order(board)).toEqual(['1', '3', '2']);
  });

  it('sinks the driver who just returned to the bottom of the available group', () => {
    // 1, 2, 3 all available; 2 went out most recently and is back.
    const board = [
      driver({ name: '1', last_trip_at: '2026-08-02T09:00:00.000Z' }),
      driver({ name: '2', last_trip_at: '2026-08-02T11:00:00.000Z' }),
      driver({ name: '3', last_trip_at: '2026-08-02T10:00:00.000Z' }),
    ];
    expect(order(board)).toEqual(['1', '3', '2']);
  });

  it('rotates again after the next dispatch, so no one is skipped twice', () => {
    // Continuing above: 1 then goes out and returns at 12:00.
    const board = [
      driver({ name: '1', last_trip_at: '2026-08-02T12:00:00.000Z' }),
      driver({ name: '2', last_trip_at: '2026-08-02T11:00:00.000Z' }),
      driver({ name: '3', last_trip_at: '2026-08-02T10:00:00.000Z' }),
    ];
    expect(order(board)).toEqual(['3', '2', '1']);
  });

  it('puts a driver currently out on an order below every available driver', () => {
    const board = [
      driver({ name: 'out', available: false, open_trip_since: '2026-08-02T11:30:00.000Z' }),
      driver({ name: 'free', last_trip_at: '2026-08-02T11:00:00.000Z' }),
    ];
    expect(order(board)).toEqual(['free', 'out']);
  });

  it('puts off-shift drivers last, below one out on an order', () => {
    const board = [
      driver({ name: 'off', clocked_in: false, available: false }),
      driver({ name: 'out', available: false, open_trip_since: '2026-08-02T11:30:00.000Z' }),
      driver({ name: 'free' }),
    ];
    expect(order(board)).toEqual(['free', 'out', 'off']);
  });

  it('falls back to name only when turn order is genuinely tied', () => {
    const board = [driver({ name: 'zoe' }), driver({ name: 'adam' })];
    expect(order(board)).toEqual(['adam', 'zoe']);
  });
});
