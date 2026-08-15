// Rasterises apps/web/public/icon.svg into the PNG sizes iOS and Android need.
// Written against node:zlib alone so the repo gains no image dependency.
//
//   node scripts/make-icons.mjs
//
// The source SVG is pure geometry (a rounded square, a stroked polyline and two
// dots), so it is reproduced here as signed-distance tests rather than parsed.
// Distance-to-polyline gives the round caps and joins for free.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

const VIEWBOX = 512;
const CORNER_RADIUS = 112;
const STROKE_RADIUS = 26 / 2;
const DOT_RADIUS = 24;
const SAMPLES = 4;

const BG = [0x25, 0x63, 0xeb];
const FG = [0xff, 0xff, 0xff];

// "M120 132h44l30 176h150l52-128H180" resolved to absolute points.
const CART = [
  [120, 132],
  [164, 132],
  [194, 308],
  [344, 308],
  [396, 180],
  [180, 180],
];
const DOTS = [
  [206, 372],
  [356, 372],
];

function roundedSquareSdf(x, y) {
  const half = VIEWBOX / 2;
  const inner = half - CORNER_RADIUS;
  const qx = Math.abs(x - half) - inner;
  const qy = Math.abs(y - half) - inner;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - CORNER_RADIUS;
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function isCart(x, y) {
  for (let i = 0; i < CART.length - 1; i += 1) {
    if (distanceToSegment(x, y, CART[i], CART[i + 1]) <= STROKE_RADIUS) return true;
  }
  return DOTS.some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= DOT_RADIUS);
}

// iOS masks the home-screen icon itself, and renders any transparency behind it
// as black — so apple-touch-icon is drawn full-bleed with square corners.
function renderRgba(size, { rounded = true } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = VIEWBOX / size;
  const step = 1 / SAMPLES;
  const perPixel = SAMPLES * SAMPLES;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      // Accumulate premultiplied so transparent corner samples do not darken edges.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) * step) * scale;
          const y = (py + (sy + 0.5) * step) * scale;
          if (rounded && roundedSquareSdf(x, y) > 0) continue;
          const [cr, cg, cb] = isCart(x, y) ? FG : BG;
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const alpha = a / perPixel;
      const offset = (py * size + px) * 4;
      if (alpha > 0) {
        pixels[offset] = Math.round(r / perPixel / (alpha / 255));
        pixels[offset + 1] = Math.round(g / perPixel / (alpha / 255));
        pixels[offset + 2] = Math.round(b / perPixel / (alpha / 255));
      }
      pixels[offset + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, opts] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['apple-touch-icon.png', 180, { rounded: false }],
]) {
  const png = encodePng(size, renderRgba(size, opts));
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name} (${size}x${size}) ${png.length} bytes`);
}
