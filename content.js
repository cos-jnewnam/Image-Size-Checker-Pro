// Image Size Checker Pro — Content Script & Non-Destructive Shadow DOM Overlay Engine
(() => {
  if (window.__ISC_PRO_LOADED__) {
    return;
  }
  window.__ISC_PRO_LOADED__ = true;

  const DEFAULT_SETTINGS = {
    enabled: true,
    overlayMode: 'all', // 'all' | 'issues' | 'hover' | 'off'
    maxFileSizeKB: 250,
    aspectRatioTolerancePct: 3.0,
    oversizeDprMultiplier: 1.6,
    bytesPerPixelTarget: 0.35,
    scanCssBackgrounds: true,
    scanInlineSvgs: true,
    minDimensionPx: 24
  };

  let settings = { ...DEFAULT_SETTINGS };
  let analyzedItems = [];
  let elementMap = new Map();
  let itemByElement = new WeakMap();
  let hoveredItemId = null;
  let pinnedItemId = null;
  let highlightedItemId = null;
  let scanCounter = 0;
  let scanTimer = null;
  let rafPending = false;

  let hostEl = null;
  let shadowRoot = null;
  let badgesLayer = null;
  let tooltipEl = null;

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  function simplifyRatio(w, h) {
    if (!w || !h) return 'N/A';
    const ratio = w / h;
    const commonRatios = [
      [1, 1, '1:1'],
      [16, 9, '16:9'],
      [9, 16, '9:16'],
      [4, 3, '4:3'],
      [3, 4, '3:4'],
      [3, 2, '3:2'],
      [2, 3, '2:3'],
      [21, 9, '21:9'],
      [5, 4, '5:4'],
      [4, 5, '4:5'],
      [2, 1, '2:1'],
      [1, 2, '1:2']
    ];
    for (const [rw, rh, label] of commonRatios) {
      if (Math.abs(ratio - rw / rh) < 0.025) {
        return `${label} (${ratio.toFixed(2)})`;
      }
    }
    return `${ratio.toFixed(2)}:1`;
  }

  function detectFormat(url, mimeType, kind) {
    if (kind === 'svg') return 'SVG';
    const m = (mimeType || '').toLowerCase();
    if (m.includes('avif')) return 'AVIF';
    if (m.includes('webp')) return 'WEBP';
    if (m.includes('svg')) return 'SVG';
    if (m.includes('png')) return 'PNG';
    if (m.includes('jpeg') || m.includes('jpg')) return 'JPEG';
    if (m.includes('gif')) return 'GIF';
    if (m.includes('bmp')) return 'BMP';

    const u = (url || '').toLowerCase();
    if (u.startsWith('data:image/')) {
      const sub = u.slice(11).split(/[;,]/)[0].toUpperCase();
      return sub === 'SVG+XML' ? 'SVG' : sub;
    }
    const clean = u.split('?')[0].split('#')[0];
    const extMatch = clean.match(/\.(avif|webp|png|jpe?g|gif|svg|bmp|ico)$/i);
    if (extMatch) {
      const ext = extMatch[1].toUpperCase();
      return ext === 'JPG' ? 'JPEG' : ext;
    }
    return kind === 'bg' ? 'CSS-BG' : 'IMG';
  }

  function defaultExtForFormat(format) {
    const f = (format || '').toUpperCase();
    if (f === 'PNG') return 'png';
    if (f === 'WEBP') return 'webp';
    if (f === 'SVG') return 'svg';
    if (f === 'GIF') return 'gif';
    if (f === 'AVIF') return 'avif';
    return 'jpg';
  }

  // Extract exact original filename (preserving original extension, never adding -compressed)
  function extractOriginalFilename(url, kind, format, index, el) {
    const ext = defaultExtForFormat(format);
    const dataFilename = el && el.getAttribute && el.getAttribute('data-filename');
    if (dataFilename) {
      return { filename: dataFilename, relativePath: dataFilename };
    }

    if (url && !url.startsWith('data:') && !url.startsWith('inline-')) {
      try {
        const u = new URL(url, window.location.href);
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length > 0) {
          let base = decodeURIComponent(segs[segs.length - 1]);
          base = base.replace(/[<>:"/\\|?*]+/g, '_');
          if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
            base = `${base}.${ext}`;
          }
          const relDir = segs.slice(0, -1).join('/');
          const relativePath = relDir ? `${relDir}/${base}` : base;
          return { filename: base, relativePath };
        }
      } catch (_) {}
    }

    const rawId = (el && el.id) || (el && el.getAttribute && el.getAttribute('alt')) || `${kind}-${index}`;
    const cleanSlug = String(rawId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `image-${index}`;
    const filename = /\.[a-z0-9]{2,5}$/i.test(cleanSlug) ? cleanSlug : `${cleanSlug}.${ext}`;
    return { filename, relativePath: filename };
  }

  function computeRecommendedBytes(renderedW, renderedH, format, cfg) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const targetPixels = Math.max(1, renderedW * dpr) * Math.max(1, renderedH * dpr);

    let bpp = Number(cfg.bytesPerPixelTarget) || 0.35;
    if (format === 'AVIF') bpp *= 0.65;
    else if (format === 'WEBP') bpp *= 0.8;
    else if (format === 'SVG') bpp *= 0.4;
    else if (format === 'PNG') bpp *= 1.15;

    const dynamicBudget = Math.round(targetPixels * bpp);
    const minFloor = 12 * 1024;
    const hardCap = (Number(cfg.maxFileSizeKB) || 250) * 1024;
    return Math.max(minFloor, Math.min(dynamicBudget, hardCap));
  }

  function getPerformanceResourceSize(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return 0;
    try {
      const entries = performance.getEntriesByName(url, 'resource');
      if (entries && entries.length > 0) {
        const last = entries[entries.length - 1];
        if (last.encodedBodySize > 0) return last.encodedBodySize;
        if (last.transferSize > 0) return last.transferSize;
        if (last.decodedBodySize > 0) return last.decodedBodySize;
      }
    } catch (_) {}
    return 0;
  }

  function computeDataUriMeta(url) {
    const commaIdx = url.indexOf(',');
    const header = commaIdx > -1 ? url.slice(5, commaIdx) : '';
    const body = commaIdx > -1 ? url.slice(commaIdx + 1) : '';
    const mimeMatch = header.match(/^([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const isBase64 = header.includes(';base64');
    const fileSize = isBase64
      ? Math.floor((body.length * 3) / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
      : new Blob([body]).size;
    return { ok: true, fileSize: Math.max(0, fileSize), mimeType };
  }

  function askBackgroundMeta(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve({ ok: false, fileSize: 0, mimeType: '' });
        return;
      }
      if (url.startsWith('data:')) {
        resolve(computeDataUriMeta(url));
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'GET_IMAGE_META', url }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            resolve({ ok: false, fileSize: 0, mimeType: '' });
          } else {
            resolve(resp);
          }
        });
      } catch (_) {
        resolve({ ok: false, fileSize: 0, mimeType: '' });
      }
    });
  }

  function loadOffscreenDimensions(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve({ width: 0, height: 0 });
        return;
      }
      const img = new Image();
      const timer = setTimeout(() => resolve({ width: 0, height: 0 }), 2500);
      img.onload = () => {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve({ width: 0, height: 0 });
      };
      img.src = url;
    });
  }

  function ensureShadowDom() {
    if (hostEl && document.documentElement.contains(hostEl)) return;

    hostEl = document.createElement('div');
    hostEl.id = 'isc-pro-shadow-host';
    hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:visible;';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      .isc-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .isc-box {
        position: fixed;
        pointer-events: none;
        border-radius: 4px;
        transition: transform 0.12s ease, opacity 0.15s ease;
      }
      .isc-box.status-error {
        outline: 2px solid rgba(239, 68, 68, 0.92);
        box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.35), 0 0 0 2px rgba(15, 23, 42, 0.35);
      }
      .isc-box.status-warn {
        outline: 2px dashed rgba(245, 158, 11, 0.92);
        box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.3);
      }
      .isc-box.status-ok {
        outline: 1.5px solid rgba(16, 185, 129, 0.75);
      }
      .isc-box.pulse-focus {
        outline: 4px solid #38bdf8 !important;
        box-shadow: 0 0 0 6px rgba(56, 189, 248, 0.35), 0 0 28px rgba(56, 189, 248, 0.85) !important;
      }
      .isc-pill {
        position: absolute;
        top: 4px;
        left: 4px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.35;
        letter-spacing: 0.01em;
        color: #f8fafc;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
        pointer-events: auto;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        backdrop-filter: blur(6px);
      }
      .isc-pill:hover {
        transform: scale(1.04);
      }
      .isc-pill .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .isc-pill.status-error {
        background: rgba(127, 29, 29, 0.94);
        border-color: rgba(252, 165, 165, 0.45);
      }
      .isc-pill.status-error .dot {
        background: #f87171;
        box-shadow: 0 0 6px #ef4444;
      }
      .isc-pill.status-warn {
        background: rgba(120, 53, 15, 0.94);
        border-color: rgba(253, 211, 77, 0.45);
      }
      .isc-pill.status-warn .dot {
        background: #fbbf24;
      }
      .isc-pill.status-ok {
        background: rgba(6, 78, 59, 0.92);
        border-color: rgba(110, 231, 183, 0.4);
      }
      .isc-pill.status-ok .dot {
        background: #34d399;
      }
      .isc-tooltip {
        position: fixed;
        width: 340px;
        background: rgba(15, 23, 42, 0.97);
        color: #f1f5f9;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 10px;
        padding: 11px 12px;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.52);
        font-size: 12px;
        line-height: 1.4;
        pointer-events: auto;
        z-index: 2147483647;
        backdrop-filter: blur(10px);
        display: none;
      }
      .isc-tooltip.visible {
        display: block;
      }
      .isc-tt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding-bottom: 7px;
        margin-bottom: 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      }
      .isc-tt-title {
        font-weight: 700;
        font-size: 12px;
        color: #f8fafc;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 195px;
      }
      .isc-tt-badges {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .isc-tag {
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .isc-tag.fmt {
        background: rgba(56, 189, 248, 0.18);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.35);
      }
      .isc-tag.status-error {
        background: rgba(239, 68, 68, 0.22);
        color: #fca5a5;
      }
      .isc-tag.status-warn {
        background: rgba(245, 158, 11, 0.22);
        color: #fde68a;
      }
      .isc-tag.status-ok {
        background: rgba(16, 185, 129, 0.22);
        color: #6ee7b7;
      }
      .isc-tt-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 10px;
        margin-bottom: 8px;
      }
      .isc-metric {
        background: rgba(30, 41, 59, 0.72);
        border: 1px solid rgba(148, 163, 184, 0.14);
        border-radius: 6px;
        padding: 5px 7px;
      }
      .isc-metric-label {
        font-size: 10px;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .isc-metric-val {
        font-size: 12px;
        font-weight: 600;
        color: #f8fafc;
        margin-top: 1px;
      }
      .isc-metric-sub {
        font-size: 10px;
        color: #cbd5e1;
      }
      .isc-issues {
        margin: 6px 0 0;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(127, 29, 29, 0.32);
        border: 1px solid rgba(248, 113, 113, 0.3);
      }
      .isc-issues.warn-only {
        background: rgba(120, 53, 15, 0.32);
        border-color: rgba(251, 191, 36, 0.3);
      }
      .isc-issue-item {
        font-size: 11px;
        color: #fecaca;
        margin: 2px 0;
        display: flex;
        align-items: flex-start;
        gap: 5px;
      }
      .isc-issues.warn-only .isc-issue-item {
        color: #fde68a;
      }
      .isc-tt-footer {
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px solid rgba(148, 163, 184, 0.16);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 10px;
        color: #94a3b8;
      }
      .isc-tt-actions {
        display: flex;
        gap: 5px;
      }
      .isc-btn {
        background: rgba(56, 189, 248, 0.16);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.35);
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
      }
      .isc-btn:hover {
        background: rgba(56, 189, 248, 0.28);
      }
    `;

    badgesLayer = document.createElement('div');
    badgesLayer.className = 'isc-layer';

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'isc-tooltip';

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(badgesLayer);
    shadowRoot.appendChild(tooltipEl);
    document.documentElement.appendChild(hostEl);
  }

  async function analyzeCandidate(candidate, index) {
    const { el, kind, url } = candidate;
    const rect = el.getBoundingClientRect();
    const renderedW = Math.round(rect.width);
    const renderedH = Math.round(rect.height);

    let intrinsicW = 0;
    let intrinsicH = 0;
    let fileSize = 0;
    let mimeType = '';
    let altText = '';
    let loadingAttr = '';
    let hasDimensionAttrs = true;
    let isInPicture = false;
    let svgMarkup = '';

    const computed = window.getComputedStyle(el);
    const objectFit = computed.objectFit || 'fill';

    if (kind === 'img') {
      intrinsicW = el.naturalWidth || 0;
      intrinsicH = el.naturalHeight || 0;
      altText = el.getAttribute('alt');
      loadingAttr = (el.getAttribute('loading') || 'eager').toLowerCase();
      hasDimensionAttrs =
        (el.hasAttribute('width') && el.hasAttribute('height')) ||
        Boolean(computed.aspectRatio && computed.aspectRatio !== 'auto');
      isInPicture = Boolean(el.closest('picture'));
    } else if (kind === 'svg') {
      const vb = el.viewBox && el.viewBox.baseVal;
      intrinsicW = Math.round((vb && vb.width) || renderedW);
      intrinsicH = Math.round((vb && vb.height) || renderedH);
      svgMarkup = el.outerHTML || '';
      fileSize = new Blob([svgMarkup]).size;
      mimeType = 'image/svg+xml';
      altText = el.getAttribute('aria-label') || el.querySelector('title')?.textContent || '';
    } else if (kind === 'bg') {
      const dims = await loadOffscreenDimensions(url);
      intrinsicW = dims.width;
      intrinsicH = dims.height;
      altText = el.getAttribute('aria-label') || '';
    }

    if (kind !== 'svg' && url) {
      fileSize = getPerformanceResourceSize(url);
      if (!fileSize || !mimeType) {
        const meta = await askBackgroundMeta(url);
        if (meta.fileSize > 0) fileSize = meta.fileSize;
        if (meta.mimeType) mimeType = meta.mimeType;
      }
    }

    const format = detectFormat(url, mimeType, kind);
    const { filename, relativePath } = extractOriginalFilename(url, kind, format, index, el);
    const recommendedBytes = computeRecommendedBytes(renderedW, renderedH, format, settings);

    let aspectMismatchPct = 0;
    const renderedRatio = renderedW > 0 && renderedH > 0 ? renderedW / renderedH : 0;
    const intrinsicRatio = intrinsicW > 0 && intrinsicH > 0 ? intrinsicW / intrinsicH : 0;
    if (renderedRatio > 0 && intrinsicRatio > 0 && kind !== 'svg') {
      aspectMismatchPct = Number(
        (Math.abs(renderedRatio - intrinsicRatio) / intrinsicRatio * 100).toFixed(1)
      );
    }

    const dpr = window.devicePixelRatio || 1;
    const idealMaxW = Math.round(renderedW * dpr * (Number(settings.oversizeDprMultiplier) || 1.6));
    const idealMaxH = Math.round(renderedH * dpr * (Number(settings.oversizeDprMultiplier) || 1.6));

    const issues = [];
    let severity = 'ok';
    let isTooLarge = false;

    const promoteSeverity = (level) => {
      if (level === 'error') severity = 'error';
      else if (level === 'warn' && severity === 'ok') severity = 'warn';
    };

    const hardCapBytes = (Number(settings.maxFileSizeKB) || 250) * 1024;
    let savingsBytes = 0;
    if (fileSize > 0) {
      if (fileSize > hardCapBytes) {
        isTooLarge = true;
        savingsBytes = Math.max(0, fileSize - recommendedBytes);
        issues.push({
          code: 'FILE_OVER_CAP',
          level: 'error',
          text: `File size (${formatBytes(fileSize)}) exceeds ${settings.maxFileSizeKB} KB cap. Optimal target: ~${formatBytes(recommendedBytes)}.`
        });
        promoteSeverity('error');
      } else if (fileSize > recommendedBytes * 1.35 && fileSize > 35 * 1024) {
        isTooLarge = true;
        savingsBytes = Math.max(0, fileSize - recommendedBytes);
        issues.push({
          code: 'FILE_OVER_RECOMMENDED',
          level: 'error',
          text: `Heavy for display size: ${formatBytes(fileSize)} vs. ~${formatBytes(recommendedBytes)} recommended.`
        });
        promoteSeverity('error');
      }
    }

    const tol = Number(settings.aspectRatioTolerancePct) || 3.0;
    if (aspectMismatchPct > tol && kind === 'img') {
      if (objectFit === 'cover' || objectFit === 'contain' || objectFit === 'scale-down') {
        issues.push({
          code: 'ASPECT_MASKED',
          level: 'warn',
          text: `Aspect ratio differs by ${aspectMismatchPct}% (${simplifyRatio(intrinsicW, intrinsicH)} vs ${simplifyRatio(renderedW, renderedH)}), cropped/fitted via object-fit: ${objectFit}.`
        });
        promoteSeverity('warn');
      } else {
        issues.push({
          code: 'ASPECT_DISTORTED',
          level: 'error',
          text: `Distorted aspect ratio (${aspectMismatchPct}% mismatch): intrinsic ${simplifyRatio(intrinsicW, intrinsicH)} stretched into ${simplifyRatio(renderedW, renderedH)}.`
        });
        promoteSeverity('error');
      }
    }

    if (
      kind !== 'svg' &&
      intrinsicW > 0 &&
      renderedW > 0 &&
      intrinsicW > idealMaxW &&
      intrinsicH > idealMaxH &&
      intrinsicW * intrinsicH - renderedW * renderedH * dpr * dpr > 150000
    ) {
      const oversizeFactor = (intrinsicW / (renderedW * dpr)).toFixed(1);
      if (fileSize > 30 * 1024) isTooLarge = true;
      issues.push({
        code: 'OVERSIZED_DIMENSIONS',
        level: fileSize > 80 * 1024 ? 'error' : 'warn',
        text: `Intrinsic resolution (${intrinsicW}×${intrinsicH}) is ${oversizeFactor}× larger than needed for ${renderedW}×${renderedH} @${dpr}x DPR.`
      });
      promoteSeverity(fileSize > 80 * 1024 ? 'error' : 'warn');
    }

    if (
      kind === 'img' &&
      intrinsicW > 0 &&
      renderedW > 48 &&
      intrinsicW < renderedW * 0.85
    ) {
      issues.push({
        code: 'UPSCALED_BLURRY',
        level: 'warn',
        text: `Upscaled image: ${intrinsicW}×${intrinsicH}px stretched to ${renderedW}×${renderedH}px (may appear blurry).`
      });
      promoteSeverity('warn');
    }

    if (
      (format === 'PNG' || format === 'JPEG' || format === 'GIF') &&
      fileSize > 55 * 1024
    ) {
      isTooLarge = true;
      issues.push({
        code: 'LEGACY_FORMAT',
        level: 'warn',
        text: `Unoptimized ${format} (${formatBytes(fileSize)}) — can be losslessly/high-fidelity compressed.`
      });
      promoteSeverity('warn');
    }

    if (kind === 'img') {
      if (altText === null || altText === '') {
        issues.push({
          code: 'MISSING_ALT',
          level: 'warn',
          text: altText === null ? 'Missing alt attribute (accessibility & SEO issue).' : 'Empty alt="" attribute on content image.'
        });
        promoteSeverity('warn');
      }
      if (!hasDimensionAttrs) {
        issues.push({
          code: 'CLS_RISK',
          level: 'warn',
          text: 'Missing explicit width/height attributes or CSS aspect-ratio (can cause layout shift / CLS).'
        });
        promoteSeverity('warn');
      }
      const inInitialViewport = rect.top >= 0 && rect.top < window.innerHeight;
      if (inInitialViewport && loadingAttr === 'lazy' && renderedW * renderedH > 40000) {
        issues.push({
          code: 'LCP_LAZY',
          level: 'warn',
          text: 'Above-the-fold image uses loading="lazy", which can delay Largest Contentful Paint (LCP).'
        });
        promoteSeverity('warn');
      }
    }

    const id = `isc-item-${++scanCounter}`;
    const item = {
      id,
      kind,
      url: url || (kind === 'svg' ? `data:image/svg+xml;utf8,${encodeURIComponent(svgMarkup)}` : `inline-${kind}-${index}`),
      shortName: filename,
      originalFilename: filename,
      relativePath,
      format,
      fileSize,
      fileSizeFormatted: formatBytes(fileSize),
      recommendedBytes,
      recommendedFormatted: formatBytes(recommendedBytes),
      savingsBytes,
      savingsFormatted: savingsBytes > 0 ? formatBytes(savingsBytes) : '0 KB',
      isTooLarge,
      renderedW,
      renderedH,
      intrinsicW,
      intrinsicH,
      dpr: Number(dpr.toFixed(2)),
      renderedRatioLabel: simplifyRatio(renderedW, renderedH),
      intrinsicRatioLabel: simplifyRatio(intrinsicW, intrinsicH),
      aspectMismatchPct,
      objectFit,
      altText: altText ?? null,
      loadingAttr,
      isInPicture,
      severity,
      issues
    };

    elementMap.set(id, el);
    itemByElement.set(el, item);
    return item;
  }

  function collectCandidates() {
    const list = [];
    const seenEls = new Set();
    const minPx = Number(settings.minDimensionPx) || 24;

    document.querySelectorAll('img').forEach((img) => {
      if (seenEls.has(img)) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < minPx && rect.height < minPx) return;
      const style = window.getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
      const url = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      seenEls.add(img);
      list.push({ el: img, kind: 'img', url });
    });

    if (settings.scanInlineSvgs) {
      document.querySelectorAll('svg').forEach((svg) => {
        if (seenEls.has(svg)) return;
        if (hostEl && hostEl.contains(svg)) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width < minPx || rect.height < minPx) return;
        const style = window.getComputedStyle(svg);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        seenEls.add(svg);
        list.push({ el: svg, kind: 'svg', url: 'inline-svg' });
      });
    }

    if (settings.scanCssBackgrounds) {
      const allEls = document.querySelectorAll('div, section, header, figure, a, span, article, main');
      allEls.forEach((el) => {
        if (seenEls.has(el)) return;
        if (hostEl && hostEl.contains(el)) return;
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (!bg || bg === 'none' || !bg.includes('url(')) return;
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (!match || !match[1]) return;
        const rawUrl = match[1];
        if (rawUrl.startsWith('data:image/svg+xml') && rawUrl.length < 200) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < minPx || rect.height < minPx) return;
        seenEls.add(el);
        list.push({ el, kind: 'bg', url: rawUrl });
      });
    }

    return list;
  }

  function renderTooltip(item, anchorRect) {
    if (!tooltipEl || !item) {
      if (tooltipEl) tooltipEl.classList.remove('visible');
      return;
    }

    const statusLabel =
      item.severity === 'error' ? 'Needs Fix' : item.severity === 'warn' ? 'Warning' : 'Optimized';

    const issuesHtml =
      item.issues.length > 0
        ? `<div class="isc-issues ${item.severity === 'warn' ? 'warn-only' : ''}">
            ${item.issues
              .map(
                (iss) =>
                  `<div class="isc-issue-item"><span>${iss.level === 'error' ? '●' : '▲'}</span><span>${iss.text}</span></div>`
              )
              .join('')}
          </div>`
        : '';

    tooltipEl.innerHTML = `
      <div class="isc-tt-header">
        <div class="isc-tt-title" title="${item.originalFilename}">${item.originalFilename}</div>
        <div class="isc-tt-badges">
          <span class="isc-tag fmt">${item.format}</span>
          <span class="isc-tag status-${item.severity}">${statusLabel}</span>
        </div>
      </div>
      <div class="isc-tt-grid">
        <div class="isc-metric">
          <div class="isc-metric-label">File Weight</div>
          <div class="isc-metric-val">${item.fileSizeFormatted}</div>
          <div class="isc-metric-sub">Target: ≤ ${item.recommendedFormatted}</div>
        </div>
        <div class="isc-metric">
          <div class="isc-metric-label">Dimensions (Px)</div>
          <div class="isc-metric-val">${item.renderedW}×${item.renderedH}</div>
          <div class="isc-metric-sub">Intrinsic: ${item.intrinsicW || '?'}×${item.intrinsicH || '?'}</div>
        </div>
        <div class="isc-metric">
          <div class="isc-metric-label">Aspect Ratio</div>
          <div class="isc-metric-val">${item.renderedRatioLabel}</div>
          <div class="isc-metric-sub">${
            item.aspectMismatchPct > 0
              ? `${item.aspectMismatchPct}% diff (${item.objectFit})`
              : 'Exact match'
          }</div>
        </div>
        <div class="isc-metric">
          <div class="isc-metric-label">Alt & Loading</div>
          <div class="isc-metric-val">${
            item.kind === 'img'
              ? item.altText
                ? 'Alt OK'
                : 'Missing Alt'
              : item.kind.toUpperCase()
          }</div>
          <div class="isc-metric-sub">${
            item.kind === 'img' ? `loading="${item.loadingAttr}"` : `DPR ${item.dpr}x`
          }</div>
        </div>
      </div>
      ${issuesHtml}
      <div class="isc-tt-footer">
        <span>${pinnedItemId === item.id ? '📌 Pinned (click badge to unpin)' : 'Click badge to pin details'}</span>
        <div class="isc-tt-actions">
          <button class="isc-btn" data-action="copy-url">Copy URL</button>
          ${
            item.url && !item.url.startsWith('inline-')
              ? `<button class="isc-btn" data-action="open-url">Open</button>`
              : ''
          }
        </div>
      </div>
    `;

    tooltipEl.querySelectorAll('.isc-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-action');
        if (act === 'copy-url') {
          navigator.clipboard?.writeText(item.url);
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = 'Copy URL';
          }, 1200);
        } else if (act === 'open-url') {
          window.open(item.url, '_blank', 'noopener');
        }
      });
    });

    tooltipEl.classList.add('visible');

    const ttW = 340;
    const ttH = tooltipEl.offsetHeight || 210;
    let left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - ttW - 8));
    let top = anchorRect.bottom + 8;
    if (top + ttH > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - ttH - 8);
    }
    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
  }

  function renderOverlays() {
    ensureShadowDom();
    if (!badgesLayer) return;

    badgesLayer.innerHTML = '';

    if (!settings.enabled || settings.overlayMode === 'off') {
      if (tooltipEl) tooltipEl.classList.remove('visible');
      return;
    }

    let activeTooltipItem = null;
    let activeTooltipRect = null;

    for (const item of analyzedItems) {
      const el = elementMap.get(item.id);
      if (!el || !document.documentElement.contains(el)) continue;

      if (settings.overlayMode === 'issues' && item.severity === 'ok' && highlightedItemId !== item.id) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth ||
        rect.width < 16 ||
        rect.height < 16
      ) {
        continue;
      }

      const isHoverOnly = settings.overlayMode === 'hover';
      const isActiveItem =
        hoveredItemId === item.id || pinnedItemId === item.id || highlightedItemId === item.id;

      if (isHoverOnly && !isActiveItem) {
        continue;
      }

      const box = document.createElement('div');
      box.className = `isc-box status-${item.severity}${
        highlightedItemId === item.id ? ' pulse-focus' : ''
      }`;
      box.style.left = `${Math.round(rect.left)}px`;
      box.style.top = `${Math.round(rect.top)}px`;
      box.style.width = `${Math.round(rect.width)}px`;
      box.style.height = `${Math.round(rect.height)}px`;

      const pill = document.createElement('div');
      pill.className = `isc-pill status-${item.severity}`;
      const ratioFlag = item.aspectMismatchPct > settings.aspectRatioTolerancePct ? ' · ⚠️ Ratio' : '';
      pill.innerHTML = `<span class="dot"></span><span>${item.fileSizeFormatted} · ${item.renderedW}×${item.renderedH}${ratioFlag}</span>`;

      pill.addEventListener('mouseenter', () => {
        hoveredItemId = item.id;
        renderOverlays();
      });
      pill.addEventListener('mouseleave', () => {
        if (hoveredItemId === item.id) {
          hoveredItemId = null;
          renderOverlays();
        }
      });
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pinnedItemId = pinnedItemId === item.id ? null : item.id;
        renderOverlays();
      });

      box.appendChild(pill);
      badgesLayer.appendChild(box);

      if (pinnedItemId === item.id || (!pinnedItemId && hoveredItemId === item.id)) {
        activeTooltipItem = item;
        activeTooltipRect = rect;
      }
    }

    if (activeTooltipItem && activeTooltipRect) {
      renderTooltip(activeTooltipItem, activeTooltipRect);
    } else if (tooltipEl) {
      tooltipEl.classList.remove('visible');
    }
  }

  function scheduleOverlayPositionUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderOverlays();
    });
  }

  async function runFullScan() {
    ensureShadowDom();
    elementMap.clear();
    const candidates = collectCandidates();
    const results = [];

    for (let i = 0; i < candidates.length; i++) {
      const item = await analyzeCandidate(candidates[i], i + 1);
      results.push(item);
    }

    analyzedItems = results;
    renderOverlays();

    const issueCount = analyzedItems.filter((i) => i.severity !== 'ok').length;
    try {
      chrome.runtime?.sendMessage?.({
        type: 'UPDATE_BADGE',
        issueCount,
        totalCount: analyzedItems.length,
        enabled: settings.enabled
      });
    } catch (_) {}

    return getSummaryPayload();
  }

  function getSummaryPayload() {
    const totalWeight = analyzedItems.reduce((acc, item) => acc + (item.fileSize || 0), 0);
    const totalSavings = analyzedItems.reduce((acc, item) => acc + (item.savingsBytes || 0), 0);
    const errorCount = analyzedItems.filter((i) => i.severity === 'error').length;
    const warnCount = analyzedItems.filter((i) => i.severity === 'warn').length;
    const tooLargeCount = analyzedItems.filter((i) => i.isTooLarge).length;

    return {
      ok: true,
      pageUrl: window.location.href,
      pageTitle: document.title || window.location.hostname,
      dpr: window.devicePixelRatio || 1,
      settings,
      summary: {
        totalImages: analyzedItems.length,
        totalWeight,
        totalWeightFormatted: formatBytes(totalWeight),
        totalSavings,
        totalSavingsFormatted: formatBytes(totalSavings),
        errorCount,
        warnCount,
        issueCount: errorCount + warnCount,
        tooLargeCount
      },
      items: analyzedItems
    };
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!settings.enabled || pinnedItemId) return;
      const target = e.target;
      if (!target || !(target instanceof Element)) return;
      const item = itemByElement.get(target);
      if (item && hoveredItemId !== item.id) {
        hoveredItemId = item.id;
        scheduleOverlayPositionUpdate();
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      if (!settings.enabled || pinnedItemId) return;
      const target = e.target;
      if (!target || !(target instanceof Element)) return;
      const item = itemByElement.get(target);
      if (item && hoveredItemId === item.id) {
        hoveredItemId = null;
        scheduleOverlayPositionUpdate();
      }
    },
    { passive: true }
  );

  window.addEventListener('scroll', scheduleOverlayPositionUpdate, { passive: true, capture: true });
  window.addEventListener('resize', scheduleOverlayPositionUpdate, { passive: true });

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
    let relevant = false;
    for (const m of mutations) {
      if (hostEl && hostEl.contains(m.target)) continue;
      if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'srcset')) {
        relevant = true;
        break;
      }
      if (m.addedNodes && m.addedNodes.length > 0) {
        relevant = true;
        break;
      }
    }
    if (relevant) {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        runFullScan();
      }, 650);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset']
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;

      if (msg.type === 'PING') {
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'SCAN_PAGE') {
        runFullScan().then((payload) => sendResponse(payload));
        return true;
      }

      if (msg.type === 'GET_STATE') {
        if (analyzedItems.length === 0) {
          runFullScan().then((payload) => sendResponse(payload));
          return true;
        }
        sendResponse(getSummaryPayload());
        return false;
      }

      if (msg.type === 'UPDATE_SETTINGS') {
        settings = { ...settings, ...(msg.settings || {}) };
        chrome.storage?.local?.set?.({ iscProSettings: settings });
        runFullScan().then((payload) => sendResponse(payload));
        return true;
      }

      if (msg.type === 'TOGGLE_OVERLAY') {
        settings.enabled = !settings.enabled;
        chrome.storage?.local?.set?.({ iscProSettings: settings });
        renderOverlays();
        const issueCount = analyzedItems.filter((i) => i.severity !== 'ok').length;
        chrome.runtime?.sendMessage?.({
          type: 'UPDATE_BADGE',
          issueCount,
          totalCount: analyzedItems.length,
          enabled: settings.enabled
        });
        sendResponse(getSummaryPayload());
        return false;
      }

      if (msg.type === 'SCROLL_TO_IMAGE') {
        const el = elementMap.get(msg.id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          highlightedItemId = msg.id;
          pinnedItemId = msg.id;
          renderOverlays();
          setTimeout(() => {
            if (highlightedItemId === msg.id) {
              highlightedItemId = null;
              renderOverlays();
            }
          }, 2600);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        return false;
      }

      return false;
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['iscProSettings'], (res) => {
      if (res && res.iscProSettings) {
        settings = { ...DEFAULT_SETTINGS, ...res.iscProSettings };
      }
      runFullScan();
    });
  } else {
    runFullScan();
  }
})();
