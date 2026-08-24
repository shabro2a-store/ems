'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';

// The caller's ring, as loud as a web page is allowed to make it.
//
// Two halves, and they fail in different places. This component is the siren -
// a real wailing tone, but only while a page is alive, because browsers give a
// closed tab no audio at all. Web push (see public/sw.js) covers the closed
// phone, and all it can raise there is a notification whose loudness belongs to
// the phone's own notification channel. Neither half can be dropped.
export default function DriverAlarm() {
  const [ringing, setRinging] = useState(false);
  // The browser is holding audio shut because it has had no gesture yet. The
  // alarm is then SILENT, which used to happen invisibly - the driver saw a
  // flashing screen and heard nothing, most often when they arrived by tapping
  // the notification and so never touched the page at all.
  const [muted, setMuted] = useState(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const vibrateTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureCtx = useCallback((): AudioContext | null => {
    if (!audioCtx.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      audioCtx.current = new Ctx();
    }
    return audioCtx.current;
  }, []);

  const unlock = useCallback(() => {
    const ctx = ensureCtx();
    if (!ctx) return;
    ctx
      .resume()
      .then(() => setMuted(ctx.state !== 'running'))
      .catch(() => {});
  }, [ensureCtx]);

  // Every plausible gesture, not just pointerdown. Arriving from a notification
  // tap focuses the window without ever producing one inside the page, so the
  // context stayed suspended and the next ring was mute.
  useEffect(() => {
    unlock();
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'touchstart', 'keydown', 'focus'];
    for (const e of events) window.addEventListener(e, unlock);
    document.addEventListener('visibilitychange', unlock);
    return () => {
      for (const e of events) window.removeEventListener(e, unlock);
      document.removeEventListener('visibilitychange', unlock);
    };
  }, [unlock]);

  const dismiss = useCallback(async () => {
    setRinging(false);
    await apiSend('/api/me/calls/ack');
  }, []);

  // Poll for rings. Three seconds is the floor on how late the siren can be
  // when the app is already open; a push arriving in a live tab beats it to the
  // punch through the service worker message below.
  useEffect(() => {
    let alive = true;
    async function check() {
      const r = await apiGet<{ ringing: boolean }>('/api/me/calls');
      if (alive && r.ok) setRinging(r.data.ringing);
    }
    check();
    const t = setInterval(check, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The push itself, relayed by the service worker. This is what makes the
  // siren start on the ring rather than up to three seconds after it - and in a
  // backgrounded tab, whose timers the browser throttles hard, it may be the
  // only thing that starts it at all.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type === 'driver-ring') {
        unlock();
        setRinging(true);
      } else if (type === 'driver-ring-answered') {
        void dismiss();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [unlock, dismiss]);

  // Loud wailing siren + vibration while ringing.
  useEffect(() => {
    if (!ringing) return;
    const ctx = ensureCtx();
    let osc: OscillatorNode | null = null;
    let gain: GainNode | null = null;
    let sweep: ReturnType<typeof setInterval> | null = null;

    if (ctx) {
      ctx.resume().catch(() => {});
      // Read after the resume attempt: 'running' means the tone will be heard,
      // anything else means the screen is about to flash in silence and the
      // driver has to be told to tap.
      setMuted(ctx.state !== 'running');

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
    } else {
      setMuted(true);
    }

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([600, 200, 600]);
      vibrateTimer.current = setInterval(() => navigator.vibrate([600, 200, 600]), 1400);
    }

    return () => {
      if (sweep) clearInterval(sweep);
      if (osc) {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
        osc.disconnect();
      }
      if (gain) gain.disconnect();
      if (vibrateTimer.current) clearInterval(vibrateTimer.current);
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(0);
    };
  }, [ringing, ensureCtx]);

  if (!ringing) return null;

  return (
    // The whole overlay is a gesture target, so any tap anywhere unlocks audio
    // and the siren starts even if the driver does not read the instruction.
    <div
      onPointerDown={unlock}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 p-6 text-center animate-pulse-alarm"
    >
      <div>
        <div className="text-6xl">📞</div>
        <h2 className="mt-4 text-3xl font-extrabold text-white drop-shadow">Order ready!</h2>
        <p className="mt-2 text-lg font-medium text-white/90">
          The counter is calling you to collect an order.
        </p>
        {muted && (
          <p className="mt-3 rounded-lg bg-black/30 px-3 py-2 text-base font-semibold text-white">
            🔇 Tap the screen once to turn the siren on.
          </p>
        )}
      </div>
      <button
        onClick={() => void dismiss()}
        className="rounded-2xl bg-white px-10 py-5 text-xl font-bold text-danger shadow-pop active:scale-95"
      >
        Got it — stop
      </button>
    </div>
  );
}
