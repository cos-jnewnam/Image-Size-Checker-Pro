import { crc32 } from '../js/crc32.js';

export async function deflate(data) {
  const stream = new CompressionStream('deflate');
  const result = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return new Uint8Array(await result);
}

export function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Writes an 8-bit indexed PNG (from Image Squeezer repo).
export async function encodeIndexedPng({ width, height, palette, indices }) {
  let max = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] > max) max = indices[i];
  const count = max + 1;

  const plte = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  let lastAlpha = -1;
  for (let i = 0; i < count; i++) {
    plte[i * 3] = palette[i * 4];
    plte[i * 3 + 1] = palette[i * 4 + 1];
    plte[i * 3 + 2] = palette[i * 4 + 2];
    alpha[i] = palette[i * 4 + 3];
    if (alpha[i] !== 255) lastAlpha = i;
  }

  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 3; // indexed color

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', plte),
  ];
  if (lastAlpha >= 0) parts.push(chunk('tRNS', alpha.subarray(0, lastAlpha + 1)));
  parts.push(chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Lossless Truecolor RGB / RGBA PNG encoder with adaptive per-row minimum-sum filtering
export async function encodeFilteredTruecolorPng(imageData, hasAlphaChannel) {
  const { width, height, data } = imageData;
  const bpp = hasAlphaChannel ? 4 : 3;
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);

  const prevLine = new Uint8Array(stride);
  const currLine = new Uint8Array(stride);
  const cand0 = new Uint8Array(stride);
  const cand1 = new Uint8Array(stride);
  const cand2 = new Uint8Array(stride);
  const cand4 = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    if (bpp === 4) {
      currLine.set(data.subarray(rowOff, rowOff + stride));
    } else {
      for (let x = 0, s = rowOff, d = 0; x < width; x++, s += 4, d += 3) {
        currLine[d] = data[s];
        currLine[d + 1] = data[s + 1];
        currLine[d + 2] = data[s + 2];
      }
    }

    let sum0 = 0, sum1 = 0, sum2 = 0, sum4 = 0;
    for (let i = 0; i < stride; i++) {
      const v = currLine[i];
      const a = i >= bpp ? currLine[i - bpp] : 0;
      const b = prevLine[i];
      const c = i >= bpp ? prevLine[i - bpp] : 0;

      cand0[i] = v;
      const d1 = (v - a) & 0xff;
      cand1[i] = d1;
      const d2 = (v - b) & 0xff;
      cand2[i] = d2;
      const d4 = (v - paethPredictor(a, b, c)) & 0xff;
      cand4[i] = d4;

      sum0 += v < 128 ? v : 256 - v;
      sum1 += d1 < 128 ? d1 : 256 - d1;
      sum2 += d2 < 128 ? d2 : 256 - d2;
      sum4 += d4 < 128 ? d4 : 256 - d4;
    }

    const outOffset = y * (stride + 1);
    let bestFilter = 0;
    let bestBuf = cand0;
    let bestSum = sum0;

    if (sum1 < bestSum) { bestSum = sum1; bestFilter = 1; bestBuf = cand1; }
    if (sum2 < bestSum) { bestSum = sum2; bestFilter = 2; bestBuf = cand2; }
    if (sum4 < bestSum) { bestSum = sum4; bestFilter = 4; bestBuf = cand4; }

    raw[outOffset] = bestFilter;
    raw.set(bestBuf, outOffset + 1);
    prevLine.set(currLine);
  }

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // 8-bit depth
  header[9] = hasAlphaChannel ? 6 : 2; // 6 = RGBA, 2 = RGB

  const idat = await deflate(raw);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0))
  ];

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
