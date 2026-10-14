// Strict pixel oracle, independent of the renderer. RGB expands to opaque RGBA;
// RGBA compares all four bytes, including RGB under transparent pixels.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
const MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const LIMIT = 32_000_000;
export const sha256 = b => createHash('sha256').update(b).digest('hex');
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) { c ^= x; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
export function decodePNG(b) {
  if (!Buffer.isBuffer(b) || !b.subarray(0, 8).equals(MAGIC)) throw new Error('PNG signature');
  let w, h, channels, ended = false; const parts = [];
  for (let at = 8; at < b.length;) {
    if (at + 12 > b.length) throw new Error('PNG chunk bounds');
    const n = b.readUInt32BE(at), end = at + 12 + n;
    if (end > b.length) throw new Error('PNG chunk bounds');
    const type = b.toString('ascii', at + 4, at + 8), d = b.subarray(at + 8, at + 8 + n);
    if (crc32(b.subarray(at + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw new Error('PNG CRC');
    if (type === 'IHDR') {
      if (w !== undefined || at !== 8 || n !== 13) throw new Error('PNG header');
      w = d.readUInt32BE(0); h = d.readUInt32BE(4);
      if (!w || !h || w * h > LIMIT || d[8] !== 8 || ![2, 6].includes(d[9]) || d[10] || d[11] || d[12]) throw new Error('PNG unsupported format');
      channels = d[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (!w) throw new Error('PNG data before header'); parts.push(d);
    } else if (type === 'IEND') {
      if (n || end !== b.length) throw new Error('PNG trailing bytes'); ended = true;
    } else if (type[0] === type[0].toUpperCase()) throw new Error('PNG unknown critical chunk');
    at = end;
  }
  if (!ended || !parts.length) throw new Error('PNG incomplete');
  const stride = w * channels, size = (stride + 1) * h;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: size });
  if (raw.length !== size) throw new Error('PNG data size');
  const rgba = Buffer.alloc(w * h * 4); let prev = Buffer.alloc(stride);
  const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1), filter = raw[off], row = Buffer.alloc(stride);
    if (filter > 4) throw new Error('PNG filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0, up = prev[x], c = x >= channels ? prev[x - channels] : 0;
      row[x] = (raw[off + 1 + x] + [0, a, up, Math.floor((a + up) / 2), paeth(a, up, c)][filter]) & 255;
    }
    for (let x = 0; x < w; x++) { const p = (y * w + x) * 4; for (let c = 0; c < 3; c++) rgba[p + c] = row[x * channels + c]; rgba[p + 3] = channels === 4 ? row[x * channels + 3] : 255; }
    prev = row;
  }
  return { width: w, height: h, rgba, pngHash: sha256(b), rgbaHash: sha256(rgba), format: channels === 3 ? 'RGB8 expanded alpha255' : 'RGBA8 exact' };
}
export function compareRGBA(a, b, regions = []) {
  if (a.width !== b.width || a.height !== b.height) return { pass: false, reason: 'SIZE_MISMATCH', expected: [a.width, a.height], actual: [b.width, b.height], differing: null };
  let differing = 0, maxDelta = 0, minX = a.width, minY = a.height, maxX = -1, maxY = -1;
  const coordinates = [], runs = [], counts = regions.map(r => ({ ...r, differing: 0 }));
  for (let y = 0; y < a.height; y++) {
    let start = -1;
    for (let x = 0; x < a.width; x++) {
      const p = (y * a.width + x) * 4; let different = false;
      for (let c = 0; c < 4; c++) { const d = Math.abs(a.rgba[p + c] - b.rgba[p + c]); maxDelta = Math.max(maxDelta, d); if (d) different = true; }
      if (different) {
        differing++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        if (coordinates.length < 128) coordinates.push([x, y]);
        for (const r of counts) if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) r.differing++;
        if (start < 0) start = x;
      } else if (start >= 0) { runs.push({ x: start, y, width: x - start }); start = -1; }
    }
    if (start >= 0) runs.push({ x: start, y, width: a.width - start });
  }
  // Connected clusters of horizontal pixel runs (8-neighbour connectivity).
  const parents = runs.map((_, i) => i); const root = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const rows = new Map(); runs.forEach((r, i) => { const prev = rows.get(r.y - 1) || []; for (const j of prev) { const p = runs[j]; if (r.x <= p.x + p.width && p.x <= r.x + r.width) parents[root(i)] = root(j); } const row = rows.get(r.y) || []; row.push(i); rows.set(r.y, row); });
  const clusters = new Map(); runs.forEach((r, i) => { const k = root(i), b = clusters.get(k) || { x: r.x, y: r.y, right: r.x + r.width, bottom: r.y + 1, pixels: 0 }; b.x = Math.min(b.x, r.x); b.y = Math.min(b.y, r.y); b.right = Math.max(b.right, r.x + r.width); b.bottom = Math.max(b.bottom, r.y + 1); b.pixels += r.width; clusters.set(k, b); });
  return { pass: differing === 0, differing, total: a.width * a.height, ratio: differing / (a.width * a.height), maxDelta, coordinates, bounds: differing ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null, clusters: [...clusters.values()].map(({ x, y, right, bottom, pixels }) => ({ x, y, width: right - x, height: bottom - y, pixels })).sort((a, b) => b.pixels - a.pixels), regions: counts };
}
function chunk(t, data) { const name = Buffer.from(t), b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); name.copy(b, 4); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return b; }
// Only for the oracle's known cases; filter0, RGB or RGBA, optional compression level.
export function encodeCase(w, h, rgba, { rgb = false, level = 6, note = '' } = {}) {
  const channels = rgb ? 3 : 4, header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = rgb ? 2 : 6;
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) raw[y * (w * channels + 1) + 1 + x * channels + c] = rgba[(y * w + x) * 4 + c];
  return Buffer.concat([MAGIC, chunk('IHDR', header), ...(note ? [chunk('tEXt', Buffer.from('note\0' + note))] : []), chunk('IDAT', deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}
export function knownCases() {
  const p = Buffer.from([0, 0, 0, 255, 10, 20, 30, 255, 90, 100, 110, 255, 255, 0, 3, 255]);
  const base = encodeCase(2, 2, p), off = Buffer.from(p); off[8]++;
  const alpha = Buffer.from(p); alpha[3]--;
  return [
    ['identical', base, base, true],
    ['one-pixel-one-channel-by-one', base, encodeCase(2, 2, off), false],
    ['same-pixels-different-PNG', base, encodeCase(2, 2, p, { level: 0, note: 'reencoded' }), true],
    ['size-mismatch', base, encodeCase(1, 4, p), false],
    ['RGB-vs-opaque-RGBA', base, encodeCase(2, 2, p, { rgb: true }), true],
    ['alpha-change', base, encodeCase(2, 2, alpha), false],
  ].map(([name, a, b, expected]) => { const result = compareRGBA(decodePNG(a), decodePNG(b)); return { name, expected, result, pass: result.pass === expected }; });
}
