import { makeZip } from './js/zip.js';
import { compressImageBuffer } from './js/worker.js';

let currentState = null;
let activeFilter = 'all';
let searchQuery = '';
let sortMode = 'severity';
let activeTabId = null;
let selectedDirHandle = null; // Native OS Directory Handle when chosen via showDirectoryPicker()
const compressedResults = new Map(); // item.id -> { beforeBytes, afterBytes, filename, savedPct, note }

const els = {
  pageHostLabel: document.getElementById('pageHostLabel'),
  openDemoBtn: document.getElementById('openDemoBtn'),
  rescanBtn: document.getElementById('rescanBtn'),
  enabledToggle: document.getElementById('enabledToggle'),
  kpiTotal: document.getElementById('kpiTotal'),
  kpiBreakdown: document.getElementById('kpiBreakdown'),
  kpiWeight: document.getElementById('kpiWeight'),
  kpiDpr: document.getElementById('kpiDpr'),
  kpiSavings: document.getElementById('kpiSavings'),
  kpiTooLarge: document.getElementById('kpiTooLarge'),
  kpiIssueSplit: document.getElementById('kpiIssueSplit'),
  targetFolderLabel: document.getElementById('targetFolderLabel'),
  chooseFolderBtn: document.getElementById('chooseFolderBtn'),
  resetFolderBtn: document.getElementById('resetFolderBtn'),
  compressAllZipBtn: document.getElementById('compressAllZipBtn'),
  tooLargeCountBadge: document.getElementById('tooLargeCountBadge'),
  compressionStatus: document.getElementById('compressionStatus'),
  filterTabs: document.getElementById('filterTabs'),
  searchInput: document.getElementById('searchInput'),
  sortSelect: document.getElementById('sortSelect'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDrawer: document.getElementById('settingsDrawer'),
  overlayModeSelect: document.getElementById('overlayModeSelect'),
  maxFileSizeInput: document.getElementById('maxFileSizeInput'),
  aspectToleranceInput: document.getElementById('aspectToleranceInput'),
  oversizeMultiplierInput: document.getElementById('oversizeMultiplierInput'),
  scanBgCheck: document.getElementById('scanBgCheck'),
  scanSvgCheck: document.getElementById('scanSvgCheck'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  itemsList: document.getElementById('itemsList'),
  copyMdBtn: document.getElementById('copyMdBtn'),
  exportCsvBtn: document.getElementById('exportCsvBtn'),
  exportJsonBtn: document.getElementById('exportJsonBtn')
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function base64ToUint8Array(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function uint8ToDataUrl(bytes, mime) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// Fetch raw image bytes via background service worker (bypasses CORS and uses browser cache)
async function fetchItemBuffer(item) {
  if (!item || !item.url) throw new Error('Missing image URL');

  if (item.url.startsWith('data:')) {
    const commaIdx = item.url.indexOf(',');
    const header = commaIdx > -1 ? item.url.slice(5, commaIdx) : '';
    const body = commaIdx > -1 ? item.url.slice(commaIdx + 1) : '';
    if (header.includes(';base64')) {
      return base64ToUint8Array(body).buffer;
    }
    return new TextEncoder().encode(decodeURIComponent(body)).buffer;
  }

  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_BYTES', url: item.url }, (r) =>
      resolve(r || { ok: false, error: 'Failed to fetch image bytes' })
    );
  });

  if (!resp.ok || !resp.base64) {
    throw new Error(resp.error || 'Could not read image bytes');
  }
  return base64ToUint8Array(resp.base64).buffer;
}

// Save a Blob/Uint8Array either into the user-chosen DirectoryHandle (if selected)
// or via the Native OS Save-As file picker (showSaveFilePicker / chrome.downloads with saveAs: true).
async function saveToTargetDestination(bytes, filename, mimeType) {
  const cleanName = filename.replace(/^\/+/, '');
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });

  // Option A: User explicitly picked a target folder via Choose Folder (File System Access API)
  if (selectedDirHandle) {
    try {
      const baseName = cleanName.split('/').pop() || cleanName;
      const fileHandle = await selectedDirHandle.getFileHandle(baseName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, method: 'directory-handle', path: `${selectedDirHandle.name}/${baseName}` };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, cancelled: true };
      }
      // Fall through to Native OS Save-As dialog if folder permission expired
    }
  }

  // Option B: Native OS Save-As Picker via chrome.downloads.download({ saveAs: true })
  const baseName = cleanName.split('/').pop() || cleanName;
  const dataUrl = uint8ToDataUrl(bytes, mimeType);
  const dlResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRIGGER_NATIVE_DOWNLOAD',
        dataUrl,
        filename: baseName,
        saveAs: true
      },
      (r) => resolve(r || { ok: false })
    );
  });

  if (dlResp && dlResp.ok) {
    return { ok: true, method: 'chrome-downloads-save-as', path: baseName };
  }

  // Fallback anchor download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = baseName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, method: 'anchor-fallback', path: baseName };
}

// Compress a single image keeping original dimensions, original format, and original filename
async function compressSingleItem(item, triggerSave = true) {
  const rawBuffer = await fetchItemBuffer(item);
  const origBytes = new Uint8Array(rawBuffer);
  const result = await compressImageBuffer({
    buffer: rawBuffer,
    quality: 92, // High-fidelity quality ("Do not lose quality")
    target: item.recommendedBytes || 0
  });

  const outBytes = new Uint8Array(result.buffer);
  const savedBytes = Math.max(0, origBytes.length - outBytes.length);
  const savedPct = origBytes.length > 0 ? Math.round((savedBytes / origBytes.length) * 100) : 0;

  compressedResults.set(item.id, {
    beforeBytes: origBytes.length,
    afterBytes: outBytes.length,
    savedBytes,
    savedPct,
    filename: item.originalFilename,
    note: result.note,
    width: result.width || item.intrinsicW,
    height: result.height || item.intrinsicH
  });

  if (triggerSave) {
    await saveToTargetDestination(outBytes, item.originalFilename, result.mime);
  }

  return {
    filename: item.originalFilename,
    relativePath: item.relativePath || item.originalFilename,
    data: outBytes,
    mime: result.mime,
    beforeBytes: origBytes.length,
    afterBytes: outBytes.length,
    savedBytes,
    savedPct
  };
}

// Batch compress all oversized images and package into a single ZIP keeping original filenames
async function compressAllTooLargeToZip() {
  if (!currentState || !currentState.items) return;
  const candidates = currentState.items.filter((i) => i.isTooLarge);
  if (candidates.length === 0) {
    els.compressionStatus.textContent = 'No oversized images found!';
    return;
  }

  els.compressAllZipBtn.disabled = true;
  const zipEntries = [];
  const usedZipNames = new Set();
  let totalBefore = 0;
  let totalAfter = 0;

  try {
    for (let idx = 0; idx < candidates.length; idx++) {
      const item = candidates[idx];
      els.compressionStatus.textContent = `Compressing ${idx + 1}/${candidates.length}: ${item.originalFilename}…`;
      const res = await compressSingleItem(item, false);
      totalBefore += res.beforeBytes;
      totalAfter += res.afterBytes;

      // Keep exact original filename; if a page has two different images with the same filename in different folders,
      // use its relative URL folder path so no image is overwritten inside the ZIP.
      let entryName = res.filename;
      if (usedZipNames.has(entryName)) {
        entryName = res.relativePath !== res.filename ? res.relativePath : `${idx + 1}_${res.filename}`;
      }
      usedZipNames.add(entryName);

      zipEntries.push({
        name: entryName,
        data: res.data
      });
      renderDashboard();
    }

    const zipBlob = makeZip(zipEntries);
    const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
    const savedTotal = Math.max(0, totalBefore - totalAfter);
    const pctTotal = totalBefore > 0 ? Math.round((savedTotal / totalBefore) * 100) : 0;

    let hostSlug = 'site';
    try {
      hostSlug = new URL(currentState.pageUrl).hostname.replace(/[^a-z0-9-]+/gi, '-') || 'site';
    } catch (_) {}
    const zipFilename = `${hostSlug}-optimized-images.zip`;

    await saveToTargetDestination(zipBytes, zipFilename, 'application/zip');
    els.compressionStatus.textContent = `Saved ZIP! ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (-${pctTotal}%)`;
  } catch (err) {
    els.compressionStatus.textContent = `Error: ${err.message || err}`;
  } finally {
    els.compressAllZipBtn.disabled = false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

async function ensureAndScan(forceRescan = false) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    els.itemsList.innerHTML = `<div class="empty-state">No active tab detected.</div>`;
    return;
  }
  activeTabId = tab.id;

  const ensureResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId: activeTabId }, (r) =>
      resolve(r || { ok: false })
    );
  });

  if (!ensureResp.ok) {
    els.pageHostLabel.textContent = 'Restricted browser page';
    els.itemsList.innerHTML = `
      <div class="empty-state">
        Chrome blocks extensions from running on internal <code>chrome://</code> or Web Store pages.<br/><br/>
        Click <strong>Playground</strong> above to open the built-in test page and try 1-click and ZIP image compression!
      </div>`;
    return;
  }

  const state = await sendToTab(activeTabId, { type: forceRescan ? 'SCAN_PAGE' : 'GET_STATE' });
  if (!state || !state.ok) {
    els.itemsList.innerHTML = `<div class="empty-state">Unable to read page images. Click Scan to retry.</div>`;
    return;
  }

  currentState = state;
  renderDashboard();
}

function populateSettingsInputs(s) {
  if (!s) return;
  els.enabledToggle.checked = Boolean(s.enabled);
  els.overlayModeSelect.value = s.overlayMode || 'all';
  els.maxFileSizeInput.value = s.maxFileSizeKB ?? 250;
  els.aspectToleranceInput.value = s.aspectRatioTolerancePct ?? 3.0;
  els.oversizeMultiplierInput.value = s.oversizeDprMultiplier ?? 1.6;
  els.scanBgCheck.checked = s.scanCssBackgrounds !== false;
  els.scanSvgCheck.checked = s.scanInlineSvgs !== false;
}

function filterAndSortItems(items) {
  const q = searchQuery.trim().toLowerCase();

  const filtered = items.filter((item) => {
    if (activeFilter === 'toolarge' && !item.isTooLarge) return false;
    if (activeFilter === 'issues' && item.severity === 'ok') return false;
    if (
      activeFilter === 'aspect' &&
      !item.issues.some((i) => i.code === 'ASPECT_DISTORTED' || i.code === 'ASPECT_MASKED')
    ) {
      return false;
    }
    if (
      activeFilter === 'oversized' &&
      !item.issues.some((i) => i.code === 'OVERSIZED_DIMENSIONS' || i.code === 'UPSCALED_BLURRY')
    ) {
      return false;
    }
    if (activeFilter === 'alt' && !item.issues.some((i) => i.code === 'MISSING_ALT')) {
      return false;
    }

    if (q) {
      const hay = `${item.originalFilename} ${item.shortName} ${item.url} ${item.format} ${
        item.altText || ''
      } ${item.issues.map((i) => i.text).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const severityRank = { error: 3, warn: 2, ok: 1 };
  filtered.sort((a, b) => {
    if (sortMode === 'severity') {
      const diff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
      if (diff !== 0) return diff;
      return (b.fileSize || 0) - (a.fileSize || 0);
    }
    if (sortMode === 'size-desc') {
      return (b.fileSize || 0) - (a.fileSize || 0);
    }
    if (sortMode === 'aspect-desc') {
      return (b.aspectMismatchPct || 0) - (a.aspectMismatchPct || 0);
    }
    return 0;
  });

  return filtered;
}

function renderDashboard() {
  if (!currentState) return;
  const { summary, items, settings, pageUrl, dpr } = currentState;

  try {
    const u = new URL(pageUrl);
    els.pageHostLabel.textContent = u.hostname + u.pathname;
  } catch (_) {
    els.pageHostLabel.textContent = pageUrl || 'Active tab';
  }

  populateSettingsInputs(settings);

  const imgCount = items.filter((i) => i.kind === 'img').length;
  const bgCount = items.filter((i) => i.kind === 'bg').length;
  const svgCount = items.filter((i) => i.kind === 'svg').length;
  const tooLargeItems = items.filter((i) => i.isTooLarge);

  els.kpiTotal.textContent = String(summary.totalImages);
  els.kpiBreakdown.textContent = `${imgCount} IMG · ${bgCount} BG · ${svgCount} SVG`;
  els.kpiWeight.textContent = summary.totalWeightFormatted;
  els.kpiDpr.textContent = `Display DPR ${Number(dpr || 1).toFixed(1)}x`;
  els.kpiSavings.textContent = summary.totalSavingsFormatted;
  els.kpiTooLarge.textContent = String(tooLargeItems.length);
  els.kpiIssueSplit.textContent = `${summary.errorCount} critical · ${summary.warnCount} warn`;
  els.tooLargeCountBadge.textContent = String(tooLargeItems.length);
  els.compressAllZipBtn.disabled = tooLargeItems.length === 0;

  const visibleItems = filterAndSortItems(items);
  if (visibleItems.length === 0) {
    els.itemsList.innerHTML = `<div class="empty-state">No images match the current filter.</div>`;
    return;
  }

  els.itemsList.innerHTML = visibleItems
    .map((item) => {
      const canPreview = item.url && !item.url.startsWith('inline-');
      const thumbHtml = canPreview
        ? `<img src="${escapeHtml(item.url)}" alt="" loading="lazy" />`
        : `<span class="thumb-fallback">${escapeHtml(item.format)}</span>`;

      const statusLabel =
        item.severity === 'error' ? 'Error' : item.severity === 'warn' ? 'Warn' : 'OK';

      const compInfo = compressedResults.get(item.id);
      const compPillHtml = compInfo
        ? `<div class="compress-result-pill">
            ✓ ${formatBytes(compInfo.beforeBytes)} → <strong>${formatBytes(compInfo.afterBytes)}</strong>
            (${compInfo.savedPct > 0 ? `-${compInfo.savedPct}%` : 'already optimal'} · ${compInfo.width}×${compInfo.height}px kept)
          </div>`
        : '';

      const issuesHtml =
        item.issues.length > 0
          ? `<div class="item-issues">
              ${item.issues
                .map(
                  (iss) =>
                    `<div class="issue-line ${iss.level === 'warn' ? 'warn' : ''}">• ${escapeHtml(
                      iss.text
                    )}</div>`
                )
                .join('')}
            </div>`
          : '';

      return `
        <div class="item-card status-${item.severity}" data-id="${escapeHtml(item.id)}">
          <div class="thumb-wrap">${thumbHtml}</div>
          <div class="item-body">
            <div class="item-header">
              <span class="item-name" title="Original Filename: ${escapeHtml(
                item.originalFilename
              )}">${escapeHtml(item.originalFilename)}</span>
              <div class="item-badges">
                <span class="badge fmt">${escapeHtml(item.format)}</span>
                <span class="badge status-${item.severity}">${statusLabel}</span>
              </div>
            </div>
            <div class="item-specs">
              <span><strong>Size:</strong> ${escapeHtml(item.fileSizeFormatted)} (≤ ${escapeHtml(
        item.recommendedFormatted
      )})</span>
              <span><strong>Rendered:</strong> ${item.renderedW}×${item.renderedH}px</span>
              <span><strong>Intrinsic:</strong> ${item.intrinsicW || '?'}×${
        item.intrinsicH || '?'
      }px</span>
              <span><strong>Ratio:</strong> ${
                item.aspectMismatchPct > 0 ? `${item.aspectMismatchPct}% diff` : 'Match'
              }</span>
            </div>
            ${compPillHtml}
            ${issuesHtml}
          </div>
          <div class="item-actions">
            <button class="mini-btn compress-btn" data-act="compress" data-id="${escapeHtml(
              item.id
            )}" title="Compress &amp; save ${escapeHtml(
        item.originalFilename
      )} keeping original dimensions &amp; format">🗜️ Compress</button>
            <button class="mini-btn" data-act="locate" data-id="${escapeHtml(
              item.id
            )}" title="Scroll to image on page">Locate</button>
            <button class="mini-btn" data-act="copy" data-url="${escapeHtml(
              item.url
            )}" title="Copy image URL">Copy</button>
          </div>
        </div>
      `;
    })
    .join('');

  els.itemsList.querySelectorAll('.mini-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (act === 'compress' && currentState) {
        const targetItem = currentState.items.find((x) => x.id === id);
        if (!targetItem) return;
        btn.disabled = true;
        btn.textContent = 'Working…';
        try {
          const res = await compressSingleItem(targetItem, true);
          els.compressionStatus.textContent = `Saved ${res.filename} (-${res.savedPct}%)`;
          renderDashboard();
        } catch (err) {
          btn.textContent = 'Error';
          els.compressionStatus.textContent = `Error: ${err.message || err}`;
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = '🗜️ Compress';
          }, 1500);
        }
      } else if (act === 'locate' && activeTabId) {
        sendToTab(activeTabId, { type: 'SCROLL_TO_IMAGE', id });
      } else if (act === 'copy') {
        const url = btn.getAttribute('data-url') || '';
        navigator.clipboard?.writeText(url);
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1000);
      }
    });
  });
}

// Target Folder Picker (Native OS Directory Picker + Save-As fallback)
els.chooseFolderBtn.addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (handle) {
        selectedDirHandle = handle;
        els.targetFolderLabel.textContent = `/${handle.name}/`;
        els.resetFolderBtn.classList.remove('hidden');
        els.compressionStatus.textContent = `Folder set: ${handle.name}`;
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        els.compressionStatus.textContent = 'Using Save-As dialog on download';
      }
    }
  } else {
    els.compressionStatus.textContent = 'Native Save-As picker active on every save';
  }
});

els.resetFolderBtn.addEventListener('click', () => {
  selectedDirHandle = null;
  els.targetFolderLabel.textContent = 'Native OS Save-As Dialog';
  els.resetFolderBtn.classList.add('hidden');
  els.compressionStatus.textContent = 'Switched to Save-As prompt';
});

els.compressAllZipBtn.addEventListener('click', () => {
  compressAllTooLargeToZip();
});

els.rescanBtn.addEventListener('click', () => ensureAndScan(true));

els.openDemoBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('demo-playground.html') });
});

els.enabledToggle.addEventListener('change', async () => {
  if (!activeTabId) return;
  const state = await sendToTab(activeTabId, {
    type: 'UPDATE_SETTINGS',
    settings: { enabled: els.enabledToggle.checked }
  });
  if (state && state.ok) {
    currentState = state;
    renderDashboard();
  }
});

els.filterTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  els.filterTabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  activeFilter = btn.getAttribute('data-filter') || 'all';
  renderDashboard();
});

els.searchInput.addEventListener('input', () => {
  searchQuery = els.searchInput.value;
  renderDashboard();
});

els.sortSelect.addEventListener('change', () => {
  sortMode = els.sortSelect.value;
  renderDashboard();
});

els.settingsBtn.addEventListener('click', () => {
  els.settingsDrawer.classList.toggle('hidden');
});

els.saveSettingsBtn.addEventListener('click', async () => {
  if (!activeTabId) return;
  const newSettings = {
    enabled: els.enabledToggle.checked,
    overlayMode: els.overlayModeSelect.value,
    maxFileSizeKB: Number(els.maxFileSizeInput.value) || 250,
    aspectRatioTolerancePct: Number(els.aspectToleranceInput.value) || 3.0,
    oversizeDprMultiplier: Number(els.oversizeMultiplierInput.value) || 1.6,
    scanCssBackgrounds: els.scanBgCheck.checked,
    scanInlineSvgs: els.scanInlineSvgs ? els.scanSvgCheck.checked : true
  };
  els.settingsDrawer.classList.add('hidden');
  const state = await sendToTab(activeTabId, { type: 'UPDATE_SETTINGS', settings: newSettings });
  if (state && state.ok) {
    currentState = state;
    renderDashboard();
  }
});

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.exportJsonBtn.addEventListener('click', () => {
  if (!currentState) return;
  triggerDownload(
    'image-audit-report.json',
    JSON.stringify(currentState, null, 2),
    'application/json'
  );
});

els.exportCsvBtn.addEventListener('click', () => {
  if (!currentState || !currentState.items) return;
  const headers = [
    'OriginalFilename',
    'Kind',
    'Format',
    'Severity',
    'TooLarge',
    'FileSizeBytes',
    'RecommendedBytes',
    'RenderedWxH',
    'IntrinsicWxH',
    'AspectMismatchPct',
    'ObjectFit',
    'AltText',
    'Issues',
    'URL'
  ];
  const rows = currentState.items.map((i) => [
    i.originalFilename,
    i.kind,
    i.format,
    i.severity,
    i.isTooLarge,
    i.fileSize,
    i.recommendedBytes,
    `${i.renderedW}x${i.renderedH}`,
    `${i.intrinsicW}x${i.intrinsicH}`,
    i.aspectMismatchPct,
    i.objectFit,
    i.altText ?? '',
    i.issues.map((x) => x.text).join(' | '),
    i.url
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  triggerDownload('image-audit-report.csv', csv, 'text/csv;charset=utf-8;');
});

els.copyMdBtn.addEventListener('click', () => {
  if (!currentState || !currentState.items) return;
  const lines = [
    `### Image Audit Report — ${currentState.pageTitle}`,
    `- **Total Images:** ${currentState.summary.totalImages} (${currentState.summary.totalWeightFormatted})`,
    `- **Too Large / Compressible:** ${currentState.summary.tooLargeCount}`,
    `- **Issues Found:** ${currentState.summary.issueCount} (${currentState.summary.errorCount} critical, ${currentState.summary.warnCount} warnings)`,
    '',
    '| Original Filename | Format | Size (Target) | Rendered | Intrinsic | Aspect Diff | Issues |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
  ];
  currentState.items.forEach((i) => {
    const iss = i.issues.map((x) => x.text).join('; ') || 'OK';
    lines.push(
      `| ${i.originalFilename} | ${i.format} | ${i.fileSizeFormatted} (≤${i.recommendedFormatted}) | ${i.renderedW}×${i.renderedH} | ${i.intrinsicW}×${i.intrinsicH} | ${i.aspectMismatchPct}% | ${iss} |`
    );
  });
  navigator.clipboard?.writeText(lines.join('\n'));
  els.copyMdBtn.textContent = 'Copied MD!';
  setTimeout(() => {
    els.copyMdBtn.textContent = 'Copy Markdown';
  }, 1400);
});

ensureAndScan(false);
