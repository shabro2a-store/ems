// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

/*
 * #45 and #46: the order siren.
 *  - A ring that arrived while the phone had not yet allowed sound showed
 *    "tap the screen once to turn the siren on" - and the tap never started
 *    the siren. And every tap, focus or tab switch reloaded the siren, which
 *    stops one already sounding.
 *  - The alarm lived on the Trips tab only: a driver on Advances, Leave or Pay
 *    had no siren at all.
 */
const ring = { ringing: true };
vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(async (url: string) =>
    url === '/api/me/ping'
      ? { ok: true, data: { role: role.current, userId: 'u1' } }
      : { ok: true, data: { ringing: ring.ringing } },
  ),
  apiSend: vi.fn(async () => ({ ok: true, data: {} })),
}));
const role = { current: 'DRIVER' };
vi.mock('next/navigation', () => ({ usePathname: () => '/employee/advances' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement('a', { href, ...rest }, children as never),
}));

import DriverAlarm from '@/components/field/DriverAlarm';
import FieldShell from '@/components/field/FieldShell';

// The phone's media rules, reduced to what matters: until a gesture unlocks
// audio, play() is refused; load() resets an element and stops it.
let unlocked = false;
const playing = new Set<HTMLMediaElement>();
const loads: string[] = [];
const src = (el: HTMLMediaElement) => el.getAttribute('src') ?? '';

beforeEach(() => {
  unlocked = false;
  playing.clear();
  loads.length = 0;
  ring.ringing = true;
  role.current = 'DRIVER';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    if (!unlocked) return Promise.reject(new DOMException('no gesture yet', 'NotAllowedError'));
    playing.add(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    playing.delete(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    loads.push(src(this));
    playing.delete(this);
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return !playing.has(this);
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount(el: ReturnType<typeof createElement>): Promise<Root> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
  });
  // Let the poll answer and the effects that follow it run.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return root;
}

const siren = () => document.querySelector('audio[src="/siren.wav"]') as HTMLAudioElement | null;

describe('the siren', () => {
  it('starts on the tap the ringing screen asks for', async () => {
    await mount(createElement(DriverAlarm));
    expect(document.body.textContent).toContain('Tap the screen once to turn the siren on');
    expect(playing.has(siren()!)).toBe(false);

    unlocked = true; // the tap is the gesture that allows sound
    const overlay = document.querySelector('.fixed.inset-0') as HTMLElement;
    await act(async () => {
      overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(playing.has(siren()!)).toBe(true);
  });

  it('keeps sounding when the driver touches the screen or comes back to the app', async () => {
    unlocked = true;
    await mount(createElement(DriverAlarm));
    expect(playing.has(siren()!)).toBe(true);
    const loadsWhileSounding = loads.length;
    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(loads.slice(loadsWhileSounding)).toEqual([]);
    expect(playing.has(siren()!)).toBe(true);
  });
});

describe('where the siren lives', () => {
  it('is on every tab a driver can open, not only Trips', async () => {
    await mount(createElement(FieldShell, null, createElement('p', null, 'Advances')));
    expect(siren()).not.toBeNull();
  });

  it('is not given to somebody who does not drive', async () => {
    role.current = 'EMPLOYEE';
    await mount(createElement(FieldShell, null, createElement('p', null, 'Advances')));
    expect(siren()).toBeNull();
  });
});
