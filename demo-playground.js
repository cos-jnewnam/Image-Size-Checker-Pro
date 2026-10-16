// Populate synthetic test images (including unoptimized PNG & JPEG payloads) on the diagnostic playground page
(function () {
  function makeCanvasDataUrl(w, h, drawFn, mime = 'image/png', quality = 0.92) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    drawFn(ctx, w, h);
    return c.toDataURL(mime, quality);
  }

  // Create an uncompressed store-mode PNG (valid PNG with store-level zlib blocks so it is >350 KB and compresses losslessly by >80%)
  function makeUnoptimizedPngDataUrl(w, h) {
    const rawStride = w * 4 + 1;
    const raw = new Uint8Array(rawStride * h);
    const palette = [
      [15, 23, 42, 255],
      [30, 41, 59, 255],
      [56, 189, 248, 255],
      [16, 185, 129, 255],
      [248, 250, 252, 255],
      [99, 102, 241, 255],
      [245, 158, 11, 255],
      [239, 68, 68, 255]
    ];
    for (let y = 0; y < h; y++) {
      const rowStart = y * rawStride;
      raw[rowStart] = 0; // filter None
      for (let x = 0; x < w; x++) {
        const idx = ((Math.floor(x / 24) + Math.floor(y / 24)) % palette.length);
        const col = palette[idx];
        const p = rowStart + 1 + x * 4;
        raw[p] = col[0];
        raw[p + 1] = col[1];
        raw[p + 2] = col[2];
        raw[p + 3] = col[3];
      }
    }

    // Wrap raw scanlines in valid uncompressed zlib (stored deflate blocks) so it's ~350KB+ before lossless compression
    const maxBlock = 65535;
    const numBlocks = Math.ceil(raw.length / maxBlock);
    const zlibLen = 2 + raw.length + numBlocks * 5 + 4;
    const zlib = new Uint8Array(zlibLen);
    zlib[0] = 0x78;
    zlib[1] = 0x01;
    let pos = 2;
    for (let i = 0; i < numBlocks; i++) {
      const start = i * maxBlock;
      const end = Math.min(raw.length, start + maxBlock);
      const len = end - start;
      const isLast = i === numBlocks - 1 ? 1 : 0;
      zlib[pos++] = isLast;
      zlib[pos++] = len & 0xff;
      zlib[pos++] = (len >>> 8) & 0xff;
      const nlen = (~len) & 0xffff;
      zlib[pos++] = nlen & 0xff;
      zlib[pos++] = (nlen >>> 8) & 0xff;
      zlib.set(raw.subarray(start, end), pos);
      pos += len;
    }
    // Adler-32 checksum
    let s1 = 1, s2 = 0;
    for (let i = 0; i < raw.length; i++) {
      s1 = (s1 + raw[i]) % 65521;
      s2 = (s2 + s1) % 65521;
    }
    const adler = ((s2 << 16) | s1) >>> 0;
    zlib[pos++] = (adler >>> 24) & 0xff;
    zlib[pos++] = (adler >>> 16) & 0xff;
    zlib[pos++] = (adler >>> 8) & 0xff;
    zlib[pos++] = adler & 0xff;

    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    function crc32(buf) {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    }
    function makeChunk(type, data) {
      const out = new Uint8Array(12 + data.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
      return out;
    }

    const ihdr = new Uint8Array(13);
    const idv = new DataView(ihdr.buffer);
    idv.setUint32(0, w);
    idv.setUint32(4, h);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA

    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const cIhdr = makeChunk('IHDR', ihdr);
    const cIdat = makeChunk('IDAT', zlib);
    const cIend = makeChunk('IEND', new Uint8Array(0));

    const png = new Uint8Array(sig.length + cIhdr.length + cIdat.length + cIend.length);
    let o = 0;
    for (const p of [sig, cIhdr, cIdat, cIend]) {
      png.set(p, o);
      o += p.length;
    }

    let binary = '';
    const chunkSz = 0x8000;
    for (let i = 0; i < png.length; i += chunkSz) {
      binary += String.fromCharCode.apply(null, png.subarray(i, i + chunkSz));
    }
    return 'data:image/png;base64,' + btoa(binary);
  }

  // 1. Optimized lightweight JPEG
  document.getElementById('imgOptimized').src = makeCanvasDataUrl(
    320,
    180,
    (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#0284c7');
      g.addColorStop(1, '#10b981');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('320×180 Optimized', 55, 96);
    },
    'image/jpeg',
    0.75
  );

  // 2. Distorted 1:1 -> 2:1
  document.getElementById('imgDistorted').src = makeCanvasDataUrl(
    400,
    400,
    (ctx, w, h) => {
      ctx.fillStyle = '#7c3aed';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#ddd6fe';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 120, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('400×400 (1:1)', 115, 208);
    },
    'image/jpeg',
    0.8
  );

  // 3. Heavy Quality-1.0 JPEG (1280x720) that compresses cleanly at quality 0.92
  document.getElementById('imgCover').src = makeCanvasDataUrl(
    1280,
    720,
    (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, 700);
      g.addColorStop(0, '#0f766e');
      g.addColorStop(0.5, '#0284c7');
      g.addColorStop(1, '#1e1b4b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(${(i * 47) % 255}, ${(i * 93) % 255}, ${(i * 151) % 255}, 0.28)`;
        ctx.beginPath();
        ctx.arc((i * 137) % w, (i * 89) % h, 14 + (i % 28), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 42px sans-serif';
      ctx.fillText('product-feature.jpg (1280×720)', 290, 370);
    },
    'image/jpeg',
    1.0
  );

  // 4. Unoptimized store-mode PNG (360×240 => ~348 KB uncompressed, shrinks to <10 KB losslessly!)
  document.getElementById('imgOversized').src = makeUnoptimizedPngDataUrl(360, 240);

  // 5. Upscaled tiny image
  document.getElementById('imgUpscaled').src = makeCanvasDataUrl(
    80,
    50,
    (ctx, w, h) => {
      ctx.fillStyle = '#d97706';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.fillText('80x50px', 16, 28);
    },
    'image/jpeg',
    0.7
  );

  // 6. CSS Background image
  const bgUrl = makeCanvasDataUrl(
    960,
    540,
    (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#1e293b');
      g.addColorStop(1, '#334155');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 400; i++) {
        ctx.strokeStyle = `rgba(56, 189, 248, ${(i % 5) * 0.08 + 0.1})`;
        ctx.strokeRect((i * 53) % w, (i * 41) % h, 42, 42);
      }
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText('section-bg.jpg (960×540)', 230, 280);
    },
    'image/jpeg',
    1.0
  );
  document.getElementById('bgHeroBox').style.backgroundImage = `url("${bgUrl}")`;
})();
