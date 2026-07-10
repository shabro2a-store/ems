import { describe, it, expect } from 'vitest';
import { SHOP_TZ, todayInBeirut } from './index';

describe('time package placeholder', () => {
  it('exports SHOP_TZ constant', () => {
    expect(SHOP_TZ).toBe('Asia/Beirut');
  });

  it('todayInBeirut returns a YYYY-MM-DD string', () => {
    const d = todayInBeirut(new Date('2026-07-09T12:00:00.000Z'));
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});