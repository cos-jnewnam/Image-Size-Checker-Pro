import { encodeIndexedPng, encodeFilteredTruecolorPng } from '../src/png-indexed.js';

// High-fidelity defaults ("Do not lose quality" + "Keep original pixel dimensions" + "Keep original formats")
const DEFAULT_QUALITY = 92;
const MIN_QUALITY = 82; // Never drop below high visual quality
const MAX_QUALITY = 96;
const TARGET_STEPS = 6;

// ---------- file type detection (from Image Squeezer worker.src.js) ----------

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

export function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (ascii(b, 4, 8) === 'ftyp') {
    const brands = ascii(b, 8, Math.min(b.length, 64));
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    if (/hei|hev|mif1|msf1/.test(brands)) return 'heic';
  }
  const headStr = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 300))).trim();
  if (headStr.startsWith('<svg') || headStr.includes('<svg')) return 'svg';
  return null;
}

function isAnimated(b, kind) {
  if (kind === 'gif') {
    let frames = 0;
    for (let i = 0; i < b.length - 3; i++) {
      if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) frames++;
      if (frames > 1) return true;
    }
  }
  if (kind === 'png') return ascii(b, 0, Math.min(b.length, 256)).includes('acTL');
  if (kind === 'webp') return ascii(b, 0, Math.min(b.length, 128)).includes('ANIM');
  return false;
}

const MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml'
};

function hasAlpha(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function flattenToWhite(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) continue;
    const inv = 255 - a;
    data[i] = (data[i] * a + 255 * inv) / 255;
    data[i + 1] = (data[i + 1] * a + 255 * inv) / 255;
    data[i + 2] = (data[i + 2] * a + 255 * inv) / 255;
    data[i + 3] = 255;
  }
}

// Builds an exact lossless palette when the image uses <= 256 colors (from Image Squeezer worker.src.js)
function exactPalette(data) {
  const seen = new Map();
  const indices = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const key = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    let index = seen.get(key);
    if (index === undefined) {
      if (seen.size === 256) return null;
      index = seen.size;
      seen.set(key, index);
    }
    indices[p] = index;
  }
  const palette = new Uint8Array(seen.size * 4);
  let n = 0;
  for (const key of seen.keys()) {
    palette[n] = key >>> 24;
    palette[n + 1] = (key >>> 16) & 0xff;
    palette[n + 2] = (key >>> 8) & 0xff;
    palette[n + 3] = key & 0xff;
    n += 4;
  }
  return { palette, indices };
}

// Lossless PNG optimization: tests exact 8-bit indexed palette (if <=256 colors),
// adaptive Paeth/Sub filtered truecolor RGB/RGBA deflate, and browser native PNG encode, returning the smallest lossless result.
async function encodeLosslessPng(imageData, canvas, alpha) {
  const { width, height } = imageData;
  const candidates = [];

  const exact = exactPalette(imageData.data);
  if (exact) {
    try {
      candidates.push(await encodeIndexedPng({ width, height, ...exact }));
    } catch (_) {}
  }

  try {
    candidates.push(await encodeFilteredTruecolorPng(imageData, alpha));
  } catch (_) {}

  try {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    candidates.push(new Uint8Array(await blob.arrayBuffer()));
  } catch (_) {}

  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

async function encodeJpg(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function encodeWebp(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 });
  return blob.type === 'image/webp' ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// Binary searches quality within high-fidelity range [MIN_QUALITY..MAX_QUALITY] to meet target without losing visual quality.
async function fitToTarget(encodeAt, target) {
  let lo = MIN_QUALITY;
  let hi = MAX_QUALITY;
  let fit = null;
  let smallest = null;
  for (let i = 0; i < TARGET_STEPS && lo <= hi; i++) {
    const q = Math.round((lo + hi) / 2);
    const out = await encodeAt(q);
    if (!out) break;
    if (!smallest || out.length < smallest.length) smallest = out;
    if (out.length <= target) {
      fit = out;
      lo = q + 1;
    } else {
      hi = q - 1;
    }
  }
  return fit ? { out: fit, met: true } : { out: smallest, met: false };
}

function optimizeSvgLossless(bytes) {
  const text = new TextDecoder().decode(bytes);
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const out = new TextEncoder().encode(cleaned);
  return out.length < bytes.length ? out : bytes;
}

export async function compressImageBuffer({ buffer, quality = DEFAULT_QUALITY, target = 0 }) {
  const bytes = new Uint8Array(buffer);
  const kind = sniff(bytes);
  if (!kind) throw new Error('Unsupported image format.');
  if (isAnimated(bytes, kind)) {
    return {
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      kind,
      mime: MIME[kind] || 'application/octet-stream',
      width: 0,
      height: 0,
      origWidth: 0,
      origHeight: 0,
      from: kind,
      note: 'kept-animated'
    };
  }

  if (kind === 'svg') {
    const out = optimizeSvgLossless(bytes);
    return {
      buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
      kind: 'svg',
      mime: MIME.svg,
      width: 0,
      height: 0,
      origWidth: 0,
      origHeight: 0,
      from: 'svg',
      note: out.length < bytes.length ? 'compressed' : 'kept'
    };
  }

  const bitmap = await createImageBitmap(new Blob([bytes], { type: MIME[kind] }));
  const origWidth = bitmap.width;
  const origHeight = bitmap.height;
  // Strictly preserve original pixel dimensions as requested
  const width = origWidth;
  const height = origHeight;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  const alpha = hasAlpha(imageData.data);
  const q = Number.isFinite(quality) ? Math.min(96, Math.max(MIN_QUALITY, Math.round(quality))) : DEFAULT_QUALITY;
  const goal = Number.isFinite(target) && target > 0 ? Math.round(target) : 0;

  // Strictly preserve original format when supported (JPEG->JPEG, PNG->PNG, WebP->WebP)
  let outKind = kind;
  let out = null;
  let missed = false;

  if (kind === 'webp') {
    const probe = await encodeWebp(canvas, q);
    if (probe) {
      if (goal && probe.length > goal) {
        const fit = await fitToTarget((v) => encodeWebp(canvas, v), goal);
        out = fit.out || probe;
        missed = !fit.met;
      } else {
        out = probe;
      }
    }
  } else if (kind === 'png' || kind === 'gif' || kind === 'bmp') {
    outKind = 'png';
    out = await encodeLosslessPng(imageData, canvas, alpha);
  } else {
    outKind = 'jpeg';
    if (alpha) {
      flattenToWhite(imageData.data);
      ctx.putImageData(imageData, 0, 0);
    }
    const probe = await encodeJpg(canvas, q);
    if (goal && probe.length > goal) {
      const fit = await fitToTarget((v) => encodeJpg(canvas, v), goal);
      out = fit.out || probe;
      missed = !fit.met;
    } else {
      out = probe;
    }
  }

  let note = 'compressed';
  if (goal && outKind !== 'png') note = missed ? 'target-missed' : 'target';

  // Never allow the output to grow larger than the original file
  if (!out || out.length >= bytes.length) {
    out = bytes;
    outKind = kind;
    note = 'kept';
  }

  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    kind: outKind,
    mime: MIME[outKind] || 'application/octet-stream',
    target: goal,
    width,
    height,
    origWidth,
    origHeight,
    from: kind,
    note
  };
}

if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async (event) => {
    const { id } = event.data;
    try {
      const result = await compressImageBuffer(event.data);
      self.postMessage({ id, ok: true, ...result }, [result.buffer]);
    } catch (err) {
      const message = err && err.message ? err.message : 'Could not compress this image.';
      self.postMessage({ id, ok: false, error: message });
    }
  };
}
