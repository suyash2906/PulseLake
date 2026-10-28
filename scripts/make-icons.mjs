// Generates the PWA / home-screen icons (PNG) for the Responder app with no image tools:
// a dark rounded square, a cyan->violet ring and the PulseLake heartbeat line, 4x supersampled.
//   node scripts/make-icons.mjs   ->  web/public/icons/*.png
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../web/public/icons");
mkdirSync(out, { recursive: true });

// heartbeat polyline in a 0..24 box (same path as the logo: M2 12h4l2.5-6 4 12 3-8 1.5 2H22)
const PULSE = [[2, 12], [6, 12], [8.5, 6], [12.5, 18], [15.5, 10], [17, 12], [22, 12]];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function sample(x, y, size, mono) {
  // x, y in 0..1 ; returns [r, g, b, a] 0..255
  const cx = x - 0.5, cy = y - 0.5;
  const r = Math.hypot(cx, cy);
  // rounded square background (full bleed for maskable icons)
  const inSquare = mono ? false : Math.max(Math.abs(cx), Math.abs(cy)) < 0.5;
  let col = inSquare ? [6, 10, 20, 255] : [0, 0, 0, 0];
  const ring = r > 0.3 && r < 0.36;
  if (ring && !mono) {
    const k = (Math.atan2(cy, cx) + Math.PI) / (2 * Math.PI);
    col = [Math.round(76 + (123 - 76) * k), Math.round(201 + (97 - 201) * k), Math.round(240 + (255 - 240) * k), 255];
  }
  // pulse line, scaled into the ring
  const px = (x - 0.5) / 0.5 * 12 * 0.95 + 12, py = (y - 0.5) / 0.5 * 12 * 0.95 + 12;
  let d = Infinity;
  for (let i = 0; i < PULSE.length - 1; i++) d = Math.min(d, segDist(px, py, PULSE[i], PULSE[i + 1]));
  if (d < 1.15) col = [255, 255, 255, 255];
  return col;
}

function png(size, mono = false) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, size, mono);
          for (let k = 0; k < 3; k++) acc[k] += c[k] * c[3];
          acc[3] += c[3];
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3] / (SS * SS);
      for (let k = 0; k < 3; k++) raw[o + k] = acc[3] ? Math.round(acc[k] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

for (const [name, size, mono] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180], ["badge-96.png", 96, true]]) {
  writeFileSync(resolve(out, name), png(size, mono));
  console.log("wrote", name);
}
