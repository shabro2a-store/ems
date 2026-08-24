'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';

/*
 * The caller's ring, made to behave like an incoming call.
 *
 * Three things had to change from the first version, and the middle one is the
 * whole difference between "a faint ping" and a siren.
 *
 * 1. It is a MEDIA element, not a WebAudio oscillator. A backgrounded page has
 *    its timers throttled to a crawl, which turned the oscillator's 500ms pitch
 *    sweep into a stutter, and WebAudio in a hidden page is suspended outright
 *    on some Android builds. An <audio loop> is playback, not a timer: Android
 *    treats it the way it treats a music app and keeps it running.
 *
 * 2. A silent keep-alive loop runs the whole shift. Chrome freezes a
 *    backgrounded page after a few minutes and a frozen page can play nothing
 *    at all - which is why the siren only ever started once somebody opened the
 *    app. Active media playback is one of the few things that stops the freeze,
 *    so the page holds an inaudible loop from the first tap onward and is still
 *    alive, and still able to blast, when the push arrives minutes later.
 *
 * 3. It plays until the driver stops it. Not for 45 seconds - until they press
 *    the button, exactly like a phone.
 *
 * What still cannot be done: if the app is swiped away entirely, or the phone
 * reboots, there is no page and nothing here runs. That case is the push
 * notification alone, and its loudness is the Android channel's to decide - see
 * RUNBOOK "Making the driver ring loud".
 *
 * NOTE ON VOLUME: this plays on the MEDIA stream. The push notification plays
 * on the notification stream. They are separate sliders on Android and both
 * have to be up.
 */
/**
 * iOS cannot do the backgrounded case, and the driver has to be told.
 *
 * Everything above is written for Android, where a backgrounded page kept alive
 * by media playback can be woken by a push and blast. iOS suspends a
 * backgrounded web app far harder, and starting a NEW sound from a push while
 * suspended is not something it permits - so on an iPhone the siren is a
 * foreground-only thing and a locked phone gets the notification alone, with
 * the standard notification sound, no vibration pattern, and no way to override
 * a Focus mode. A driver who taps "arm" and believes they are covered is worse
 * off than one who knows to keep the screen on.
 */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export default function DriverAlarm() {
  const [ringing, setRinging] = useState(false);
  const [ios, setIos] = useState(false);
  // Audio is still locked: the browser has had no gesture, so the alarm would
  // flash in silence. It used to do exactly that, invisibly, whenever the
  // driver arrived by tapping the notification - which never produces a gesture
  // inside the page.
  const [armed, setArmed] = useState(false);
  const siren = useRef<HTMLAudioElement | null>(null);
  const keepAlive = useRef<HTMLAudioElement | null>(null);
  const vibrateTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Hold the page alive and audio unlocked for the rest of the shift.
  const arm = useCallback(() => {
    const ka = keepAlive.current;
    const s = siren.current;
    if (!ka || !s) return;
    ka.volume = 0.02;
    ka.loop = true;
    ka.play()
      .then(() => {
        setArmed(true);
        if ('mediaSession' in navigator) {
          // Honest label: on Android this is what the media notification says,
          // and "playing" with no explanation reads like a bug.
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'On call — waiting for orders',
            artist: 'Shabro2a',
          });
        }
      })
      .catch(() => setArmed(false));
    // Prime the siren element in the same gesture so its first play() later
    // needs no permission of its own.
    s.volume = 1;
    s.load();
  }, []);

  useEffect(() => setIos(isIos()), []);

  useEffect(() => {
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'touchstart', 'keydown', 'focus'];
    for (const e of events) window.addEventListener(e, arm);
    document.addEventListener('visibilitychange', arm);
    arm();
    return () => {
      for (const e of events) window.removeEventListener(e, arm);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [arm]);

  const dismiss = useCallback(async () => {
    setRinging(false);
    await apiSend('/api/me/calls/ack');
  }, []);

  // Poll while the app is open. The push below beats this to the punch, but a
  // ring raised while push is unavailable (permission refused, VAPID unset)
  // still has to reach the driver.
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

  // The push, relayed by the service worker. This is what starts the siren in a
  // backgrounded page, where the poll above is throttled to almost nothing.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type === 'driver-ring') {
        arm();
        setRinging(true);
      } else if (type === 'driver-ring-answered') {
        void dismiss();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [arm, dismiss]);

  // Siren + vibration for as long as the ring stands.
  useEffect(() => {
    const s = siren.current;
    if (!ringing || !s) return;

    s.loop = true;
    s.volume = 1;
    s.currentTime = 0;
    s.play().catch(() => setArmed(false));

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([600, 200, 600]);
      vibrateTimer.current = setInterval(() => navigator.vibrate([600, 200, 600]), 1400);
    }

    return () => {
      s.pause();
      s.currentTime = 0;
      if (vibrateTimer.current) clearInterval(vibrateTimer.current);
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(0);
    };
  }, [ringing]);

  return (
    <>
      {/* Always mounted, never conditional: the siren element has to exist and
          be primed by an earlier gesture, or its first play() is refused. */}
      <audio ref={keepAlive} src="/keepalive.wav" loop preload="auto" playsInline />
      <audio ref={siren} src="/siren.wav" loop preload="auto" playsInline />

      {!ringing && !armed && (
        <button
          onClick={arm}
          className="w-full rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-left text-sm"
        >
          🔔 <b>Tap here to arm the siren.</b> Until you do, an order call can only buzz — it cannot
          make a sound.
        </button>
      )}

      {!ringing && armed && ios && (
        <div className="w-full rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-sm">
          📱 <b>On iPhone the siren only sounds while this screen is open.</b> Leave the app on
          screen while you wait for orders — if you switch away or lock the phone, a call arrives as
          a normal notification instead.
        </div>
      )}

      {ringing && (
        <div
          onPointerDown={arm}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 p-6 text-center animate-pulse-alarm"
        >
          <div>
            <div className="text-6xl">📞</div>
            <h2 className="mt-4 text-3xl font-extrabold text-white drop-shadow">Order ready!</h2>
            <p className="mt-2 text-lg font-medium text-white/90">
              The counter is calling you to collect an order.
            </p>
            {!armed && (
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
      )}
    </>
  );
}
