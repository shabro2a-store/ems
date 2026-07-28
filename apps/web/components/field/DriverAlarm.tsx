'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';

// Polls for a caller "ring" and raises a loud, flashing alarm while the app is
// open. (Phase B adds web-push so it also reaches a locked/closed phone.)
export default function DriverAlarm() {
  const [ringing, setRinging] = useState(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const beepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const vibrateTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hi = useRef(true);

  // Unlock audio on the first user gesture (browsers block audio otherwise).
  useEffect(() => {
    function unlock() {
      if (!audioCtx.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (Ctx) audioCtx.current = new Ctx();
      }
      audioCtx.current?.resume().catch(() => {});
    }
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Poll for rings.
  useEffect(() => {
    let alive = true;
    async function check() {
      const r = await apiGet<{ ringing: boolean }>('/api/me/calls');
      if (alive && r.ok) setRinging(r.data.ringing);
    }
    check();
    const t = setInterval(check, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Drive the siren + vibration while ringing.
  useEffect(() => {
    if (!ringing) return;
    const ctx = audioCtx.current;
    if (ctx) {
      ctx.resume().catch(() => {});
      beepTimer.current = setInterval(() => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = 'square';
        o.frequency.value = hi.current ? 880 : 620;
        hi.current = !hi.current;
        const t0 = ctx.currentTime;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
        o.start(t0);
        o.stop(t0 + 0.37);
      }, 450);
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([400, 150, 400]);
      vibrateTimer.current = setInterval(() => navigator.vibrate([400, 150, 400]), 1200);
    }
    return () => {
      if (beepTimer.current) clearInterval(beepTimer.current);
      if (vibrateTimer.current) clearInterval(vibrateTimer.current);
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(0);
    };
  }, [ringing]);

  async function dismiss() {
    setRinging(false);
    await apiSend('/api/me/calls/ack');
  }

  if (!ringing) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 p-6 text-center animate-pulse-alarm">
      <div>
        <div className="text-6xl">📞</div>
        <h2 className="mt-4 text-3xl font-extrabold text-white drop-shadow">Order ready!</h2>
        <p className="mt-2 text-lg font-medium text-white/90">The counter is calling you to collect an order.</p>
      </div>
      <button
        onClick={dismiss}
        className="rounded-2xl bg-white px-10 py-5 text-xl font-bold text-danger shadow-pop active:scale-95"
      >
        Got it — stop
      </button>
    </div>
  );
}
