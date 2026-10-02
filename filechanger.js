'use strict';

const UNIT_BYTES = { KB: 1024, MB: 1024 * 1024 };
const MAX_TARGET_BYTES = 500 * 1024 * 1024;
const MAX_UPSCALE_SIDE = 8000;
const MIN_QUALITY = 0.4;
const MAX_QUALITY = 0.95;

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), fileInfo: $('fileInfo'),
  infoName: $('infoName'), infoType: $('infoType'), infoSize: $('infoSize'),
  form: $('controls'), targetValue: $('targetValue'), targetUnit: $('targetUnit'),
  processBtn: $('processBtn'), loader: $('loader'), loaderText: $('loaderText'), rasterOpt: $('rasterOpt'), message: $('message'),
  result: $('result'), statOriginal: $('statOriginal'), statTarget: $('statTarget'),
  statOutput: $('statOutput'), statChange: $('statChange'),
  previews: $('previews'), origImg: $('origImg'), procImg: $('procImg'), downloadLink: $('downloadLink'),
};

const state = { file: null, busy: false, originalUrl: null, processedUrl: null };

/* ---------- Helpers ---------- */

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function replaceUrl(key, blob) {
  if (state[key]) URL.revokeObjectURL(state[key]);
  state[key] = blob ? URL.createObjectURL(blob) : null;
  return state[key];
}

function showMessage(text, kind = 'error') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
  els.message.hidden = false;
}

function setBusy(isBusy) {
  state.busy = isBusy;
  els.loader.hidden = !isBusy;
  els.loaderText.textContent = 'Processing…';
  els.processBtn.disabled = isBusy || !state.file;
}

function resetOutput() {
  els.message.hidden = true;
  els.result.hidden = true;
  els.previews.hidden = true;
  els.downloadLink.hidden = true;
  els.downloadLink.removeAttribute('href');
  els.origImg.removeAttribute('src');
  els.procImg.removeAttribute('src');
  replaceUrl('processedUrl', null);
}

function parseTargetBytes() {
  const raw = els.targetValue.value.trim();
  if (raw === '') throw new Error('Enter a target size.');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('The target size is not a valid number.');
  if (value <= 0) throw new Error('The target size must be greater than zero.');
  const bytes = Math.floor(value * UNIT_BYTES[els.targetUnit.value]);
  if (bytes < 1) throw new Error('The target size is too small.');
  if (bytes > MAX_TARGET_BYTES) throw new Error('The target size is too large (maximum 500 MB).');
  return bytes;
}

const isImage = (file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'file';

/* ---------- File selection ---------- */

function selectFile(file) {
  resetOutput();
  replaceUrl('originalUrl', null);
  state.file = file || null;
  els.fileInfo.hidden = !file;
  if (file) {
    els.infoName.textContent = file.name;
    els.infoType.textContent = file.type || 'Unknown';
    els.infoSize.textContent = `${formatBytes(file.size)} (${file.size.toLocaleString()} bytes)`;
    if (file.size === 0) {
      state.file = null;
      showMessage('This file is empty (0 bytes) and cannot be processed.');
    }
  }
  els.processBtn.disabled = !state.file || state.busy;
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', () => {
  selectFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});
['dragenter', 'dragover'].forEach((evt) => els.dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); els.dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((evt) => els.dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); els.dropzone.classList.remove('dragover');
}));
els.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
});

/* ---------- Image processing ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be decoded. It may be corrupted.'));
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed.'))), type, quality);
  });
}

// Browsers silently fall back to PNG for unsupported encoders, so verify WebP support.
function pickOutputType(file) {
  if (file.type === 'image/webp') {
    const supported = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp');
    if (supported) return 'image/webp';
  }
  return 'image/jpeg';
}

async function renderBlob(img, scale, type, quality) {
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // JPEG/WebP-lossy output: transparent areas are flattened onto white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvasToBlob(canvas, type, quality);
}

async function reduceImage(img, targetBytes, type) {
  let smallest = null;
  for (let scale = 1; scale >= 0.05; scale *= 0.85) {
    if (Math.min(img.naturalWidth, img.naturalHeight) * scale < 8) break;
    const high = await renderBlob(img, scale, type, MAX_QUALITY);
    if (high.size <= targetBytes) return high;
    const low = await renderBlob(img, scale, type, MIN_QUALITY);
    if (!smallest || low.size < smallest.size) smallest = low;
    if (low.size > targetBytes) continue; // even lowest quality too big: shrink dimensions
    let lo = MIN_QUALITY, hi = MAX_QUALITY, best = low;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      const blob = await renderBlob(img, scale, type, mid);
      if (blob.size <= targetBytes) { best = blob; lo = mid; } else { hi = mid; }
    }
    return best;
  }
  return smallest;
}

async function increaseImage(img, targetBytes, type) {
  const quality = 0.98;
  let best = await renderBlob(img, 1, type, quality);
  if (best.size >= targetBytes) return best;
  const maxScale = Math.max(1, Math.min(8, MAX_UPSCALE_SIDE / Math.max(img.naturalWidth, img.naturalHeight)));
  const largest = await renderBlob(img, maxScale, type, quality);
  if (largest.size < targetBytes) return largest;
  let lo = 1, hi = maxScale;
  best = largest;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const blob = await renderBlob(img, mid, type, quality);
    if (Math.abs(blob.size - targetBytes) < Math.abs(best.size - targetBytes)) best = blob;
    if (blob.size < targetBytes) lo = mid; else hi = mid;
  }
  return best;
}

async function processImage(file, targetBytes, mode) {
  const img = await loadImage(state.originalUrl);
  const type = mode === 'exact' ? 'image/jpeg' : pickOutputType(file);
  let blob = mode === 'reduce' ? await reduceImage(img, targetBytes, type) : await increaseImage(img, targetBytes, type);
  if (mode === 'exact' && blob.size > targetBytes) blob = await reduceImage(img, targetBytes, type);
  const paddedBytes = mode === 'exact' && blob.size < targetBytes ? targetBytes - blob.size : 0;
  if (paddedBytes) blob = await padJpegToSize(blob, targetBytes);
  const ext = type === 'image/webp' ? 'webp' : 'jpg';
  const notes = [];
  if (type !== file.type) notes.push(`The output was converted from ${file.type} to JPEG. Transparency is not preserved; transparent areas became white.`);
  if (mode !== 'reduce') notes.push('The image may have been enlarged (upscaled) at high quality to increase its byte size. No extra detail is added.');
  if (paddedBytes) notes.push(`To reach the exact size, ${formatBytes(paddedBytes)} of invisible JPEG comment padding was added. The picture is unchanged and the file is a valid JPEG.`);
  return { blob, filename: `${baseName(file.name)}-resized.${ext}`, notes, preview: true };
}

/* ---------- PDF and other files ---------- */

async function buildPdfFromJpegs(jpegs, pageSizes) {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < jpegs.length; i++) {
    const image = await doc.embedJpg(jpegs[i]);
    const page = doc.addPage(pageSizes[i]);
    page.drawImage(image, { x: 0, y: 0, width: pageSizes[i][0], height: pageSizes[i][1] });
  }
  return new Blob([await doc.save({ useObjectStreams: true })], { type: 'application/pdf' });
}

// Renders every page to a canvas, encodes it as JPEG, and rebuilds the PDF.
// Tries large scales first and picks the highest JPEG quality whose measured output fits the target.
async function rasterizePdf(file, targetBytes) {
  if (!window.pdfjsLib) throw new Error('The PDF renderer failed to load. Check your internet connection and reload.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const source = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const qualities = [0.8, 0.6, 0.45, 0.3, 0.2];
  const scales = [2, 1.5, 1.2, 1, 0.8, 0.65, 0.5, 0.4, 0.3];
  let smallest = null;

  for (const [scaleIndex, requested] of scales.entries()) {
    const jpegs = qualities.map(() => []);
    const pageSizes = [];
    for (let n = 1; n <= source.numPages; n++) {
      els.loaderText.textContent = `Optimizing PDF: pass ${scaleIndex + 1}/${scales.length}, page ${n}/${source.numPages}…`;
      const page = await source.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(requested, Math.sqrt(12e6 / (base.width * base.height))); // cap canvas size
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pageSizes.push([base.width, base.height]);
      for (let q = 0; q < qualities.length; q++) {
        const blob = await canvasToBlob(canvas, 'image/jpeg', qualities[q]);
        jpegs[q].push(new Uint8Array(await blob.arrayBuffer()));
      }
      page.cleanup();
    }
    for (let q = 0; q < qualities.length; q++) {
      const estimate = jpegs[q].reduce((sum, bytes) => sum + bytes.length, 0);
      const isLastCandidate = scaleIndex === scales.length - 1 && q === qualities.length - 1;
      if (estimate > targetBytes && !isLastCandidate) continue;
      const blob = await buildPdfFromJpegs(jpegs[q], pageSizes);
      if (blob.size <= targetBytes) return blob;
      if (!smallest || blob.size < smallest.size) smallest = blob;
    }
  }
  return smallest;
}

async function processPdf(file, targetBytes) {
  const resaved = await resavePdf(file);
  if (resaved.blob.size <= targetBytes || !els.rasterOpt.checked) return resaved;
  const rasterized = await rasterizePdf(file, targetBytes);
  if (!rasterized || rasterized.size >= resaved.blob.size) return resaved;
  return {
    blob: rasterized, filename: `${baseName(file.name)}-compressed.pdf`, requireSmaller: true,
    notes: ['Pages were converted to compressed JPEG images to reduce size. The text is no longer selectable or searchable, and quality is lower.'],
  };
}

async function resavePdf(file) {
  if (!window.PDFLib) throw new Error('The PDF library failed to load. Check your internet connection and reload.');
  let doc;
  try {
    doc = await PDFLib.PDFDocument.load(await file.arrayBuffer());
  } catch (err) {
    throw new Error('This PDF could not be read. It may be corrupted or password-protected.');
  }
  const bytes = await doc.save({ useObjectStreams: true });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  return {
    blob, filename: `${baseName(file.name)}-optimized.pdf`, requireSmaller: true,
    notes: ['PDF-lib only re-saves the document structure. It does not recompress embedded images, so savings are often small.'],
  };
}

// Pads a JPEG to an exact byte count using standard COM (comment) segments right after the SOI marker.
// Decoders skip these segments, so the file stays a valid JPEG and the picture is unchanged.
async function padJpegToSize(blob, targetBytes) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let remaining = targetBytes - bytes.length;
  const parts = [bytes.subarray(0, 2)];
  let trailing = 0;
  if (remaining > 0 && remaining < 4) { trailing = remaining; remaining = 0; } // too small for a segment
  while (remaining > 0) {
    let total = Math.min(remaining, 65535);
    if (remaining - total > 0 && remaining - total < 4) total = remaining - 4;
    const segment = new Uint8Array(total);
    segment.set([0xFF, 0xFE, (total - 2) >> 8, (total - 2) & 0xFF]);
    parts.push(segment);
    remaining -= total;
  }
  parts.push(bytes.subarray(2));
  if (trailing) parts.push(new Uint8Array(trailing)); // harmless bytes after the EOI marker
  return new Blob(parts, { type: 'image/jpeg' });
}

// Pads a PDF to an exact byte count by adding one unreferenced stream object, then re-measuring and correcting.
async function padPdfToSize(blob, targetBytes) {
  const doc = await PDFLib.PDFDocument.load(await blob.arrayBuffer());
  let padLength = Math.max(0, targetBytes - blob.size);
  for (let attempt = 0; attempt < 8 && padLength >= 0; attempt++) {
    const ref = doc.context.register(doc.context.stream(new Uint8Array(padLength)));
    const saved = await doc.save({ useObjectStreams: false });
    doc.context.delete(ref);
    if (saved.length === targetBytes) return new Blob([saved], { type: 'application/pdf' });
    padLength += targetBytes - saved.length;
  }
  return null;
}

async function processExactPdf(file, targetBytes) {
  const base = await processPdf(file, targetBytes);
  const outcome = { blob: base.blob, filename: `${baseName(file.name)}-resized.pdf`, notes: base.notes.slice(0, 1) };
  if (base.blob.size >= targetBytes) return outcome;
  const padded = await padPdfToSize(base.blob, targetBytes);
  if (!padded) {
    outcome.notes.push('The exact size could not be reached with padding.');
    return outcome;
  }
  outcome.notes.push(`${formatBytes(targetBytes - base.blob.size)} of padding was added as an unused PDF object. The pages are unchanged and the PDF stays valid, but the extra bytes carry no content.`);
  return { ...outcome, blob: padded };
}

async function processGzip(file) {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser does not support GZIP compression (Compression Streams API).');
  const stream = file.stream().pipeThrough(new CompressionStream('gzip'));
  const blob = new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
  return {
    blob, filename: `${file.name}.gz`, requireSmaller: true,
    notes: ['This file was compressed with GZIP. Extract the .gz archive to recover the original file.'],
  };
}

/* ---------- Result display ---------- */

function targetMet(mode, size, target) {
  if (mode === 'exact') return size === target;
  return mode === 'reduce' ? size <= target : Math.abs(size - target) / target <= 0.1;
}

function showResult(outcome, file, targetBytes, mode) {
  const { blob, filename, notes = [], requireSmaller, preview } = outcome;
  const lines = [...notes];
  els.statOriginal.textContent = formatBytes(file.size);
  els.statTarget.textContent = formatBytes(targetBytes);
  els.result.hidden = false;

  if (requireSmaller && blob.size >= file.size) {
    els.statOutput.textContent = formatBytes(blob.size);
    els.statChange.textContent = 'No reduction';
    showMessage(`This file could not be made smaller (best result: ${formatBytes(blob.size)}), so no download is offered. It is probably already compressed.`, 'warning');
    return;
  }

  const changePct = ((blob.size - file.size) / file.size) * 100;
  els.statOutput.textContent = `${formatBytes(blob.size)} (${blob.size.toLocaleString()} bytes)`;
  els.statChange.textContent = changePct <= 0 ? `${Math.abs(changePct).toFixed(1)}% smaller` : `${changePct.toFixed(1)}% larger`;

  const met = targetMet(mode, blob.size, targetBytes);
  lines.unshift(met
    ? `Done. The measured output is ${formatBytes(blob.size)}.`
    : mode === 'reduce' || blob.size > targetBytes
      ? `The target could not be reached. The smallest safe result is ${formatBytes(blob.size)}.`
      : `The target was not reached (output ${formatBytes(blob.size)}). Larger sizes would need dimensions beyond the safe limit.`);
  showMessage(lines.join('\n'), met ? 'success' : 'warning');

  const processedUrl = replaceUrl('processedUrl', blob);
  els.downloadLink.href = processedUrl;
  els.downloadLink.download = filename;
  els.downloadLink.textContent = `Download ${filename}`;
  els.downloadLink.hidden = false;

  if (preview) {
    els.origImg.src = state.originalUrl;
    els.procImg.src = processedUrl;
    els.previews.hidden = false;
  }
}

/* ---------- Main flow ---------- */

async function handleProcess(event) {
  event.preventDefault();
  if (state.busy || !state.file) return;
  resetOutput();
  setBusy(true);
  try {
    const file = state.file;
    const targetBytes = parseTargetBytes();
    const modeChoice = els.form.elements.mode.value;
    const mode = modeChoice === 'auto' ? (targetBytes < file.size ? 'reduce' : 'increase') : modeChoice;

    if (targetBytes === file.size) throw new Error('The target equals the current file size. Nothing to do.');
    if (mode === 'reduce' && targetBytes > file.size) throw new Error('The target is larger than the file. Choose "Increase" or "Automatic".');
    if (mode === 'increase' && targetBytes < file.size) throw new Error('The target is smaller than the file. Choose "Reduce" or "Automatic".');

    if (isImage(file)) {
      replaceUrl('originalUrl', file);
      const outcome = await processImage(file, targetBytes, mode);
      showResult(outcome, file, targetBytes, mode);
      return;
    }
    const wantsLarger = mode === 'increase' || mode === 'exact';
    if (wantsLarger && !isPdf(file)) {
      throw new Error('Increase and Exact size are only supported for images and PDFs. Other file types cannot be resized without corrupting them or changing their format.');
    }
    let outcome;
    if (!isPdf(file)) outcome = await processGzip(file);
    else outcome = wantsLarger ? await processExactPdf(file, targetBytes) : await processPdf(file, targetBytes);
    showResult(outcome, file, targetBytes, mode);
  } catch (err) {
    showMessage(err.message || 'Something went wrong while processing the file.');
  } finally {
    setBusy(false);
  }
}

els.form.addEventListener('submit', handleProcess);