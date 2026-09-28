// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { usePolling } from './usePolling';

/*
 * #53: every screen polled on a timer whether or not anybody could see it -
 * the dashboard every 10 s in a tab left open all night, the caller board
 * every 3 s. A hidden tab now skips its ticks, and refreshes the moment it is
 * looked at again.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hidden = false;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

function mount(fn: () => void, ms: number) {
  function Probe() {
    usePolling(fn, ms);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Probe)));
}

describe('usePolling', () => {
  it('ticks while the page is visible', () => {
    const fn = vi.fn();
    mount(fn, 1000);
    act(() => void vi.advanceTimersByTime(3000));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('skips ticks while the page is hidden', () => {
    const fn = vi.fn();
    mount(fn, 1000);
    hidden = true;
    act(() => void vi.advanceTimersByTime(5000));
    expect(fn).not.toHaveBeenCalled();
  });

  it('refreshes at once when the page is shown again', () => {
    const fn = vi.fn();
    mount(fn, 10_000);
    hidden = true;
    act(() => void vi.advanceTimersByTime(30_000));
    hidden = false;
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
