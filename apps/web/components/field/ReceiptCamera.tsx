'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The driver's viewfinder for the order receipt.
 *
 * Live capture only: this is the camera stream drawn to a canvas, not a file
 * picker, so nothing from the gallery can ever be handed in as a receipt. The
 * frame is captured at the stream's own size (the phone's rear camera at up to
 * 1080x1920) and encoded as a JPEG the owner can read the print off later -
 * the review, and the automated reader he wants after it, both depend on the
 * receipt filling the frame and being in focus, which is what the guide box
 * and the preview step are for.
 *
 * No camera, no photo, no trip. A denied permission or a broken camera is
 * reported and the driver cannot go out until it is fixed.
 */
export default function ReceiptCamera({
  onCapture,
  onCancel,
}: {
  onCapture: (photo: Blob) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function open() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setError('The camera is not available in this browser. Open the app in Chrome or Safari.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => undefined);
        }
        setLive(true);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was refused. Allow the camera for this site in your phone settings, then try again.'
            : name === 'NotFoundError'
              ? 'No camera was found on this phone.'
              : 'The camera could not be started. Close other apps using it and try again.',
        );
      }
    }
    open();
    return () => {
      cancelled = true;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot.url);
    };
  }, [shot]);

  const capture = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError('The photo could not be captured. Try again.');
          return;
        }
        setShot({ blob, url: URL.createObjectURL(blob) });
      },
      'image/jpeg',
      0.85,
    );
  }, []);

  const use = useCallback(() => {
    if (!shot) return;
    stop();
    onCapture(shot.blob);
  }, [shot, stop, onCapture]);

  const videoClass = 'h-full w-full object-cover' + (shot ? ' invisible' : '');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium">{shot ? 'Is the receipt readable?' : 'Photo of the order receipt'}</span>
        <button
          type="button"
          onClick={() => {
            stop();
            onCancel();
          }}
          className="rounded-lg px-3 py-1.5 text-sm text-white/80 hover:bg-white/10"
        >
          Cancel
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* The stream stays mounted under the preview so a retake is instant. */}
        <video ref={videoRef} playsInline muted autoPlay className={videoClass} />
        {shot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot.url} alt="Receipt preview" className="absolute inset-0 h-full w-full bg-black object-contain" />
        )}
        {!shot && live && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[78%] w-[62%] rounded-lg border-2 border-dashed border-white/80" />
            <p className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80">
              Fill the frame with the receipt. Hold still.
            </p>
          </div>
        )}
        {!shot && !live && !error && (
          <div className="absolute inset-0 grid place-items-center text-sm text-white/70">Starting camera…</div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="rounded-xl bg-white/10 p-4 text-center text-sm">
              <p className="font-medium">No photo, no trip.</p>
              <p className="mt-1 text-white/80">{error}</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-3 px-4 py-4">
        {shot ? (
          <>
            <button
              type="button"
              onClick={() => setShot(null)}
              className="h-14 flex-1 rounded-2xl border border-white/40 text-base font-semibold text-white"
            >
              Retake
            </button>
            <button type="button" onClick={use} className="h-14 flex-1 rounded-2xl bg-warning text-base font-bold text-white">
              Use photo · OUT
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={capture}
            disabled={!live}
            aria-label="Take photo"
            className="grid h-20 w-20 place-items-center rounded-full border-4 border-white/90 disabled:opacity-40"
          >
            <span className="h-14 w-14 rounded-full bg-white" />
          </button>
        )}
      </div>
    </div>
  );
}
