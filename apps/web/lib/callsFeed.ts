'use client';

/**
 * The driver's ring state, shared. DriverAlarm polls /api/me/calls every few
 * seconds on every tab; the Trips tab used to run its own 4-second loop on the
 * same endpoint beside it. Now the alarm publishes what it hears and the tab
 * listens.
 */
export interface CallsState {
  ringing: boolean;
  canGoOut: boolean;
}

const EVENT = 'ems:calls';

export function publishCalls(state: CallsState): void {
  window.dispatchEvent(new CustomEvent<CallsState>(EVENT, { detail: state }));
}

export function onCalls(handler: (state: CallsState) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<CallsState>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
