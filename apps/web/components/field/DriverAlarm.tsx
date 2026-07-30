'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';

// Polls for a caller "ring" and raises a loud, flashing alarm while the app is
// open. (Web push covers the locked/closed-phone case.)
export default function DriverAlarm() {
  const [ringing, setRinging] = useState(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const vibrateTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Loud wailing siren + vibration while ringing.
  useEffect(() => {
    if (!ringing) return;
    const ctx = audioCtx.current;
    let osc: OscillatorNode | null = null;
    let gain: GainNode | null = null;
    let sweep: ReturnType<typeof setInterval> | null = null;

    if (ctx) {
      ctx.resume().catch(() => {});
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      osc.type = 'sawtooth'; // harsh, carries like an emergency siren
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.85, ctx.currentTime + 0.05); // loud
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.start();
      // Wail: sweep the pitch up and down continuously.
      let up = true;
      const doSweep = () => {
        const o = osc!;
        const t = ctx.currentTime;
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(o.frequency.value, t);
        o.frequency.linearRampToValueAtTime(up ? 1400 : 600, t + 0.5);
        up = !up;
      };
      doSweep();
      sweep = setInterval(doSweep, 500);
    }

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([600, 200, 600]);
      vibrateTimer.current = setInterval(() => navigator.vibrate([600, 200, 600]), 1400);
    }

    return () => {
      if (sweep) clearInterval(sweep);
      if (osc) { try { osc.stop(); } catch { /* already stopped */ } osc.disconnect(); }
      if (gain) gain.disconnect();
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
