// Renders the PNG app icons from signed distance fields, so no image tooling is needed.
// Run: node scripts/make-icons.ts
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

const BG = [0x14, 0x53, 0x2d];
const FG = [0xbb, 0xf7, 0xd0];

function render(size: number, opts: { rounded: boolean; scale: number }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const px = 2 / size;
  const smooth = (d: number) => Math.min(1, Math.max(0, 0.5 - d / px));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      // Background: rounded square (or full bleed for maskable).
      const q = Math.max(Math.abs(u), Math.abs(v));
      const r = 0.44;
      const bx = Math.max(Math.abs(u) - (1 - r), 0);
      const by = Math.max(Math.abs(v) - (1 - r), 0);
      const bgD = opts.rounded ? Math.hypot(bx, by) - r : q - 1;
      const bgA = smooth(bgD);
      // Two interlocking capsule rings rotated 45°.
      const s = opts.scale;
      const cu = (u * Math.SQRT1_2 - v * Math.SQRT1_2) / s;
      const cv = (u * Math.SQRT1_2 + v * Math.SQRT1_2) / s;
      const ring = (cx: number) => {
        const L = 0.2;
        const rad = 0.28;
        const dx = cu - cx - Math.max(-L, Math.min(L, cu - cx));
        return Math.abs(Math.hypot(dx, cv) - rad) - 0.09;
      };
      const fgD = Math.min(ring(-0.28), ring(0.28)) * s;
      const fgA = smooth(fgD) * bgA;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[i + k] = Math.round(BG[k]! * (1 - fgA / Math.max(bgA, 1e-6)) + FG[k]! * (fgA / Math.max(bgA, 1e-6)));
      raw[i + 3] = Math.round(bgA * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = "public/icons/";
writeFileSync(`${out}icon-192.png`, render(192, { rounded: true, scale: 1 }));
writeFileSync(`${out}icon-512.png`, render(512, { rounded: true, scale: 1 }));
writeFileSync(`${out}icon-maskable-512.png`, render(512, { rounded: false, scale: 0.75 }));
writeFileSync(`${out}apple-touch-icon.png`, render(180, { rounded: false, scale: 0.85 }));
console.log("icone generate");
