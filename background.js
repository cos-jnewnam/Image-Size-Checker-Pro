// Image Size Checker Pro — Background Service Worker (Manifest V3)
// Resolves cross-origin image file weights & raw bytes without CORS blocks,
// triggers native OS Save-As downloads, and manages per-tab badges.

const metaCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function setCache(url, data) {
  if (metaCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = metaCache.keys().next().value;
    metaCache.delete(firstKey);
  }
  metaCache.set(url, data);
}

function inferMimeFromUrl(url) {
  try {
    const clean = url.split('?')[0].split('#')[0].toLowerCase();
    if (clean.endsWith('.avif')) return 'image/avif';
    if (clean.endsWith('.webp')) return 'image/webp';
    if (clean.endsWith('.png')) return 'image/png';
    if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
    if (clean.endsWith('.gif')) return 'image/gif';
    if (clean.endsWith('.svg')) return 'image/svg+xml';
    if (clean.endsWith('.bmp')) return 'image/bmp';
    if (clean.endsWith('.ico')) return 'image/x-icon';
  } catch (_) {}
  return '';
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageMeta(url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, fileSize: 0, mimeType: '' };
  }

  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',');
    const header = commaIdx > -1 ? url.slice(5, commaIdx) : '';
    const body = commaIdx > -1 ? url.slice(commaIdx + 1) : '';
    const mimeMatch = header.match(/^([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/unknown';
    const isBase64 = header.includes(';base64');
    const byteLength = isBase64
      ? Math.floor((body.length * 3) / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0)
      : new Blob([decodeURIComponent(body)]).size;
    return { ok: true, fileSize: Math.max(0, byteLength), mimeType, source: 'data-uri' };
  }

  if (metaCache.has(url)) {
    return metaCache.get(url);
  }

  let fileSize = 0;
  let mimeType = inferMimeFromUrl(url);

  try {
    const headResp = await fetch(url, {
      method: 'HEAD',
      cache: 'force-cache',
      credentials: 'omit'
    });
    if (headResp.ok) {
      const cl = headResp.headers.get('content-length');
      const ct = headResp.headers.get('content-type');
      if (ct) mimeType = ct.split(';')[0].trim();
      if (cl && Number(cl) > 0) {
        fileSize = Number(cl);
        const result = { ok: true, fileSize, mimeType, source: 'head' };
        setCache(url, result);
        return result;
      }
    }
  } catch (_) {}

  try {
    const getResp = await fetch(url, {
      method: 'GET',
      cache: 'force-cache',
      credentials: 'omit'
    });
    if (getResp.ok) {
      const ct = getResp.headers.get('content-type');
      if (ct) mimeType = ct.split(';')[0].trim();
      const cl = getResp.headers.get('content-length');
      if (cl && Number(cl) > 0) {
        fileSize = Number(cl);
      } else {
        const blob = await getResp.blob();
        fileSize = blob.size;
        if (!mimeType && blob.type) mimeType = blob.type;
      }
      const result = { ok: true, fileSize, mimeType, source: 'get-blob' };
      setCache(url, result);
      return result;
    }
  } catch (err) {
    return { ok: false, fileSize: 0, mimeType, error: String(err) };
  }

  return { ok: false, fileSize: 0, mimeType };
}

async function fetchImageBytesBase64(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid image URL');
  }
  if (url.startsWith('data:')) {
    const commaIdx = url.indexOf(',');
    const header = commaIdx > -1 ? url.slice(5, commaIdx) : '';
    const body = commaIdx > -1 ? url.slice(commaIdx + 1) : '';
    const mimeMatch = header.match(/^([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    if (header.includes(';base64')) {
      return { ok: true, base64: body, mimeType };
    }
    const rawBytes = new TextEncoder().encode(decodeURIComponent(body));
    return { ok: true, base64: uint8ToBase64(rawBytes), mimeType };
  }

  const resp = await fetch(url, {
    method: 'GET',
    cache: 'force-cache',
    credentials: 'omit'
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching image`);
  }
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const mimeType = (resp.headers.get('content-type') || inferMimeFromUrl(url) || 'image/jpeg').split(';')[0].trim();
  return { ok: true, base64: uint8ToBase64(bytes), mimeType };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'GET_IMAGE_META') {
    fetchImageMeta(message.url)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, fileSize: 0, mimeType: '', error: String(err) }));
    return true;
  }

  if (message.type === 'FETCH_IMAGE_BYTES') {
    fetchImageBytesBase64(message.url)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === 'TRIGGER_NATIVE_DOWNLOAD') {
    // Uses chrome.downloads.download with saveAs: true so the native OS folder/file picker opens reliably
    chrome.downloads.download(
      {
        url: message.dataUrl,
        filename: message.filename,
        saveAs: message.saveAs !== false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true;
  }

  if (message.type === 'UPDATE_BADGE') {
    const tabId = sender?.tab?.id || message.tabId;
    if (tabId) {
      const { issueCount, totalCount, enabled } = message;
      if (!enabled) {
        chrome.action.setBadgeText({ tabId, text: 'OFF' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#64748b' });
      } else if (issueCount > 0) {
        chrome.action.setBadgeText({ tabId, text: String(issueCount) });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
      } else if (totalCount > 0) {
        chrome.action.setBadgeText({ tabId, text: 'OK' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' });
      } else {
        chrome.action.setBadgeText({ tabId, text: '' });
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'ENSURE_CONTENT_SCRIPT') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Missing tabId' });
      return false;
    }
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (pingResp) => {
      if (!chrome.runtime.lastError && pingResp && pingResp.ok) {
        sendResponse({ ok: true, alreadyInjected: true });
      } else {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            files: ['content.js']
          },
          () => {
            if (chrome.runtime.lastError) {
              sendResponse({
                ok: false,
                error: chrome.runtime.lastError.message || 'Cannot inject into this page'
              });
            } else {
              sendResponse({ ok: true, injectedNow: true });
            }
          }
        );
      }
    });
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-inspector') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' }, () => {
        void chrome.runtime.lastError;
      });
    }
  }
});
