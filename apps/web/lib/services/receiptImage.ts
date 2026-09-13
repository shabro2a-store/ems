/**
 * What the server accepts as a receipt photo.
 *
 * The driver's screen captures it live off the camera and sends the JPEG with
 * the trip start (see startTrip); the server never sees the camera, only the
 * bytes, so this is where "a real photo, big enough to read later" is decided.
 * Anything else - a PNG, a thumbnail, a hundred-megabyte upload - is refused
 * and the trip does not start.
 */
export const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The short side is what the receipt's width lands on in portrait. Below this
 * the print is a smear, and the automated reader the owner wants later would
 * have nothing to read - the photos are kept for that as much as for him.
 */
export const RECEIPT_MIN_SHORT_SIDE = 480;

export type ReceiptInspection =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: 'NOT_JPEG' | 'TOO_SMALL' | 'TOO_LARGE' };

export function inspectReceiptJpeg(buf: Buffer): ReceiptInspection {
  if (buf.length > RECEIPT_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' };
  const size = jpegSize(buf);
  if (!size) return { ok: false, reason: 'NOT_JPEG' };
  if (Math.min(size.width, size.height) < RECEIPT_MIN_SHORT_SIDE) return { ok: false, reason: 'TOO_SMALL' };
  return { ok: true, ...size };
}

/**
 * Walk the JPEG segments to the frame header (SOF) and read the size out of
 * it. Nothing more: this is not a decoder, and a truncated file that carries
 * a frame header is still a JPEG for our purposes.
 */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    // Fill bytes and standalone markers (RSTn, SOI, TEM) carry no length.
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / scan data before any frame header
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
