import { describe, it, expect } from 'vitest';
import { NAV_ITEMS } from '../../../components/admin/AdminNav';

describe('<AdminNav> exports', () => {
  it('NAV_ITEMS is the streamlined 5-tab structure', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    // Approvals/flags live in the dashboard; schedule/adjustments live in the
    // employee & payroll screens, so the nav is intentionally just these five.
    expect(hrefs).toEqual(['/admin', '/admin/users', '/admin/branches', '/admin/punches', '/admin/payroll']);
  });

  it('each NAV_ITEMS entry has a label', () => {
    for (const item of NAV_ITEMS) {
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('each NAV_ITEMS entry has a match function', () => {
    for (const item of NAV_ITEMS) {
      expect(typeof item.match).toBe('function');
    }
  });

  it('match functions work for exact and prefix paths', () => {
    const dashboard = NAV_ITEMS.find((i) => i.href === '/admin')!;
    expect(dashboard.match('/admin')).toBe(true);
    expect(dashboard.match('/admin/users')).toBe(false);

    const users = NAV_ITEMS.find((i) => i.href === '/admin/users')!;
    expect(users.match('/admin/users')).toBe(true);
    expect(users.match('/admin/users/abc/edit')).toBe(true);
  });
});