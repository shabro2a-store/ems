import { describe, it, expect } from 'vitest';
import { inspectReceiptJpeg, RECEIPT_MAX_BYTES, RECEIPT_MIN_SHORT_SIDE } from './receiptImage';

/*
 * What the server accepts as a receipt photo. It never sees a camera, only
 * bytes, so this is where "a real photo, big enough to read later" is decided.
 */

/** A JPEG skeleton: SOI, an APP0 segment, then a SOF0 frame header with the given size. */
function jpeg(width: number, height: number, padTo = 0): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 9);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(sof.length - 2, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const body = Buffer.concat([soi, app0, sof, Buffer.from([0xff, 0xd9])]);
  return padTo > body.length ? Buffer.concat([body, Buffer.alloc(padTo - body.length)]) : body;
}

describe('inspectReceiptJpeg', () => {
  it('reads the size out of a JPEG and accepts a readable one', () => {
    expect(inspectReceiptJpeg(jpeg(1080, 1920))).toEqual({ ok: true, width: 1080, height: 1920 });
  });

  it('refuses anything that is not a JPEG', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(inspectReceiptJpeg(png)).toEqual({ ok: false, reason: 'NOT_JPEG' });
    expect(inspectReceiptJpeg(Buffer.alloc(0))).toEqual({ ok: false, reason: 'NOT_JPEG' });
  });

  it('refuses a frame too small to read a receipt off later', () => {
    // The short side is what the receipt's width lands on in portrait; below
    // this the print is a smear and the future reader has nothing to work with.
    expect(RECEIPT_MIN_SHORT_SIDE).toBe(480);
    expect(inspectReceiptJpeg(jpeg(320, 240))).toEqual({ ok: false, reason: 'TOO_SMALL' });
    expect(inspectReceiptJpeg(jpeg(480, 640))).toEqual({ ok: true, width: 480, height: 640 });
  });

  it('refuses a file over the cap', () => {
    expect(RECEIPT_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(inspectReceiptJpeg(jpeg(1080, 1920, RECEIPT_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('refuses a JPEG with no frame header', () => {
    expect(inspectReceiptJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ ok: false, reason: 'NOT_JPEG' });
  });
});
