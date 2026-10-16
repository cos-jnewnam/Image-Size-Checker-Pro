# Image Size Checker Pro (v3.1 — With Integrated Lossless/High-Fidelity Image Squeezer)

A Manifest V3 Chrome Extension that upgrades **Image Size Checker** and integrates the compression engine and store-only ZIP writer from **Image Squeezer** (`js/worker.js`, `src/png-indexed.js`, `js/zip.js`, `js/crc32.js`).

## Key Capabilities

- **Target Download Folder Selection**:
  - Click **Choose Folder…** in the popup to pick any local folder on disk (such as your website repository's `public/images/` folder) via the Native OS Directory Picker (`showDirectoryPicker`), or use the default **Native OS Save-As Dialog** (`chrome.downloads` with `saveAs: true`) on each download.
- **Single-Image & Batch ZIP Compression**:
  - Click **🗜️ Compress** on any individual image row to compress and save 1 image at a time.
  - Click **🗜️ Compress & Download All Too Large to ZIP** to compress all oversized images on the page and download them in a single `.zip` archive ready to unpack directly into your site.
- **Drop-In Site Replacement (Zero Quality or Dimension Loss)**:
  - Preserves **exact original filenames** (strips `-compressed`).
  - Preserves **original formats** (`JPEG` stays `.jpg`, `PNG` stays `.png`, `WebP` stays `.webp`, `SVG` stays `.svg`).
  - Preserves **100% of original intrinsic pixel dimensions** (`width × height`) without downscaling or blurring.

## How to Load Locally in Chrome

1. Unzip `image-size-checker-pro.zip` to a folder on your computer.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** (top-left) and select the unzipped `image-size-checker-pro` folder.
