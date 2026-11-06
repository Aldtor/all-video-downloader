const $ = (id) => document.getElementById(id);
const apiBase = String(window.FRAMEHARBOR_API_BASE || '').replace(/\/+$/, '');
const historyKey = 'frameharbor-downloads-v1';
const fallbackMemoryLimit = 150 * 1024 * 1024;
let currentMedia = null;
let saveDirectory = null;
let activeController = null;
let preparingDownload = false;

function setInteractionLocked(locked) {
  $('mediaUrl').disabled = locked;
  $('inspectButton').disabled = locked;
  $('clearPreview').disabled = locked;
  $('qualitySelect').disabled = locked;
  $('folderButton').disabled = locked;
  $('downloadButton').disabled = locked;
}

function setMessage(text, kind = '') {
  $('formMessage').textContent = text;
  $('formMessage').className = `form-message ${kind}`.trim();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Duration unavailable';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function safeFilename(title, ext = 'mp4') {
  const base = String(title || 'FrameHarbor video')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || 'FrameHarbor video';
  return `${base}.${ext}`;
}

async function apiRequest(path, options = {}) {
  if (!apiBase) throw new Error('The web download service has not been configured yet.');
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('The download service is offline or still starting. Please try again shortly.');
  }
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch { /* Use the friendly fallback below. */ }
    throw new Error(payload.error || 'The download service could not complete this request.');
  }
  return response;
}

function setEngine(online, detail) {
  $('engineDot').classList.toggle('online', online);
  $('engineLabel').textContent = online ? 'Service ready' : 'Service unavailable';
  $('engineDetail').textContent = detail;
}

function loadLibrary() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { items = []; }
  $('libraryCount').textContent = String(items.length);
  $('libraryTotal').textContent = String(items.length);
  $('emptyLibrary').hidden = items.length > 0;
  $('libraryList').hidden = items.length === 0;
  $('libraryList').replaceChildren(...items.map((item) => {
    const row = document.createElement('article');
    row.className = 'library-row';
    const art = document.createElement('span');
    art.className = 'library-art';
    art.textContent = 'FH';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('small');
    meta.textContent = item.meta;
    const info = document.createElement('span');
    info.className = 'library-info';
    info.append(title, meta);
    const status = document.createElement('span');
    status.className = 'saved-pill';
    status.textContent = 'Saved';
    row.append(art, info, status);
    return row;
  }));
}

async function checkService() {
  $('browserNotice').hidden = false;
  try {
    const response = await apiRequest('/health');
    const result = await response.json();
    setEngine(true, result.service || 'Online service');
  } catch (error) {
    setEngine(false, apiBase ? 'Check service status' : 'Service address missing');
    setMessage(error.message, 'notice');
  }
}

function updateQualityChoices() {
  const available = currentMedia?.formats || {};
  for (const option of $('qualitySelect').options) {
    option.disabled = !available[option.value];
  }
  if (!available[$('qualitySelect').value]) $('qualitySelect').value = 'best';
}

$('inspectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeController || preparingDownload) return;
  const url = $('mediaUrl').value.trim();
  if (!url) return;
  $('inspectButton').disabled = true;
  $('inspectButton').textContent = 'Checking…';
  $('inspectStatus').textContent = 'Reading link details';
  $('mediaPreview').hidden = true;
  $('downloadOptions').hidden = true;
  setMessage('');
  try {
    const response = await apiRequest('/api/inspect', { method: 'POST', body: { url } });
    currentMedia = await response.json();
    $('mediaTitle').textContent = currentMedia.title;
    $('mediaMeta').textContent = `${currentMedia.channel} · ${formatDuration(currentMedia.duration)}`;
    $('mediaPreview').hidden = false;
    $('downloadOptions').hidden = false;
    $('inspectStatus').textContent = 'Link details ready';
    updateQualityChoices();
    $('mediaUrl').blur();
  } catch (error) {
    currentMedia = null;
    $('inspectStatus').textContent = 'Could not read link';
    setMessage(error.message, 'error');
  } finally {
    $('inspectButton').disabled = false;
    $('inspectButton').innerHTML = 'Inspect link <span>→</span>';
  }
});

$('clearPreview').addEventListener('click', () => {
  if (activeController || preparingDownload) return;
  currentMedia = null;
  $('mediaPreview').hidden = true;
  $('downloadOptions').hidden = true;
  $('inspectStatus').textContent = 'Ready when you are';
  $('mediaUrl').focus();
});

$('folderButton').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    setMessage('Your browser will ask where to save the file when the download starts.', 'notice');
    return;
  }
  try {
    saveDirectory = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('folderName').textContent = saveDirectory.name || 'Selected folder';
    $('folderButton').title = saveDirectory.name || 'Selected folder';
    setMessage('Save folder selected.', 'success');
  } catch (error) {
    if (error.name !== 'AbortError') setMessage('Could not access that folder. Choose it again.', 'error');
  }
});

function showProgress(estimatedBytes, title) {
  $('progressArea').hidden = false;
  $('progressTitle').textContent = title;
  $('progressMessage').textContent = 'Connecting to the source…';
  $('progressPercent').textContent = Number.isFinite(estimatedBytes) && estimatedBytes > 0 ? '0%' : '—';
  $('progressBar').style.width = '2%';
  $('progressTrack').removeAttribute('aria-valuenow');
  $('cancelButton').textContent = 'Cancel';
}

function updateProgress(bytes, estimatedBytes) {
  $('progressMessage').textContent = `${(bytes / (1024 * 1024)).toFixed(1)} MB received`;
  if (Number.isFinite(estimatedBytes) && estimatedBytes > 0) {
    const percent = Math.min(99, (bytes / estimatedBytes) * 100);
    $('progressBar').style.width = `${Math.max(2, percent)}%`;
    $('progressPercent').textContent = `${Math.round(percent)}%`;
    $('progressTrack').setAttribute('aria-valuenow', String(Math.round(percent)));
  } else {
    $('progressBar').style.width = '30%';
    $('progressBar').classList.add('progress-indeterminate');
    $('progressPercent').textContent = '…';
  }
}

function saveBlob(chunks, filename) {
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

async function createNonCollidingFile(directory, filename) {
  const dot = filename.lastIndexOf('.');
  const name = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  for (let index = 1; index <= 100; index += 1) {
    const candidate = index === 1 ? filename : `${name} (${index})${extension}`;
    try {
      await directory.getFileHandle(candidate, { create: false });
    } catch (error) {
      if (error.name === 'NotFoundError') return directory.getFileHandle(candidate, { create: true });
      throw error;
    }
  }
  throw new Error('Could not find a free file name in the selected folder.');
}

$('downloadButton').addEventListener('click', async () => {
  if (!currentMedia || activeController || preparingDownload) return;
  const media = currentMedia;
  const quality = $('qualitySelect').value;
  const format = media.formats?.[quality];
  if (!format) {
    setMessage('That quality is not available for this link.', 'error');
    return;
  }

  const filename = safeFilename(media.title, format.ext || 'mp4');
  let fileHandle;
  preparingDownload = true;
  setInteractionLocked(true);
  try {
    if (saveDirectory) fileHandle = await createNonCollidingFile(saveDirectory, filename);
    else if (window.showSaveFilePicker) fileHandle = await window.showSaveFilePicker({ suggestedName: filename });
  } catch (error) {
    if (error.name !== 'AbortError') setMessage('Could not open the save dialog.', 'error');
    preparingDownload = false;
    setInteractionLocked(false);
    return;
  }

  if (currentMedia !== media) {
    setMessage('The link changed before saving began. Inspect it again and retry.', 'error');
    preparingDownload = false;
    setInteractionLocked(false);
    return;
  }

  const controller = new AbortController();
  activeController = controller;
  $('progressBar').classList.remove('progress-indeterminate');
  setMessage('');
  const estimatedBytes = Number(format.estimatedBytes) || 0;
  showProgress(estimatedBytes, media.title);

  let writer;
  const chunks = [];
  let received = 0;
  let fallbackLimitReached = false;
  try {
    const response = await apiRequest('/api/download', {
      method: 'POST',
      body: { url: media.url, quality },
      signal: controller.signal,
    });
    writer = fileHandle ? await fileHandle.createWritable() : null;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('This browser cannot receive a streamed download.');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!writer && received > fallbackMemoryLimit) {
        fallbackLimitReached = true;
        throw new Error('This browser cannot safely save a file this large. Use Chrome or the desktop app.');
      }
      if (writer) await writer.write(value);
      else chunks.push(value);
      updateProgress(received, estimatedBytes);
    }

    if (writer) await writer.close();
    else saveBlob(chunks, filename);
    $('progressBar').classList.remove('progress-indeterminate');
    $('progressBar').style.width = '100%';
    $('progressPercent').textContent = 'Done';
    $('progressTrack').setAttribute('aria-valuenow', '100');
    $('progressMessage').textContent = 'Saved to your device';
    $('cancelButton').textContent = 'Close';
    let items = [];
    try { items = JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { items = []; }
    items.unshift({ title: media.title, meta: `${format.ext.toUpperCase()} · ${new Date().toLocaleDateString()}` });
    try { localStorage.setItem(historyKey, JSON.stringify(items.slice(0, 20))); } catch { /* Keep this download even if browser storage is full. */ }
    loadLibrary();
  } catch (error) {
    if (!controller.signal.aborted) controller.abort();
    if (writer) {
      try { await writer.abort(); } catch { /* The browser may already have closed the partial file. */ }
    }
    const userCancelled = controller.signal.aborted && error.name === 'AbortError' && !fallbackLimitReached;
    $('progressBar').classList.remove('progress-indeterminate');
    $('progressPercent').textContent = userCancelled ? 'Stopped' : 'Error';
    $('progressMessage').textContent = userCancelled ? 'Download cancelled.' : error.message;
    $('cancelButton').textContent = 'Close';
    if (!userCancelled) setMessage(error.message, 'error');
  } finally {
    activeController = null;
    preparingDownload = false;
    setInteractionLocked(false);
  }
});

$('cancelButton').addEventListener('click', () => {
  if (activeController) {
    activeController.abort();
    $('progressMessage').textContent = 'Cancelling…';
  } else {
    $('progressArea').hidden = true;
    $('progressBar').classList.remove('progress-indeterminate');
    $('cancelButton').textContent = 'Cancel';
  }
});

loadLibrary();
checkService();
