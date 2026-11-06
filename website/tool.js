const api = window.frameHarbor;
const $ = (id) => document.getElementById(id);
const form = $('inspectForm');
const urlInput = $('mediaUrl');
const inspectButton = $('inspectButton');
const message = $('formMessage');
const preview = $('mediaPreview');
const options = $('downloadOptions');
const progressArea = $('progressArea');
const qualitySelect = $('qualitySelect');
let currentMedia = null;
let outputDirectory = '';
let runningId = null;
let runningTitle = '';
let startingDownload = false;
const earlyProgress = new Map();
const earlyFinished = new Map();
let demoMode = !api;
const historyKey = 'frameharbor-downloads-v1';

function setMessage(text, kind = '') {
  message.textContent = text;
  message.className = `form-message ${kind}`.trim();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Duration unavailable';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function setEngine(ok, detail) {
  $('engineDot').classList.toggle('online', ok);
  $('engineLabel').textContent = ok ? 'Engine ready' : 'Setup needed';
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

async function checkEngine() {
  if (!api) {
    setEngine(false, 'Desktop preview only');
    $('browserNotice').hidden = false;
    return;
  }
  try {
    const result = await api.checkEngine();
    setEngine(true, `yt-dlp ${result.version}`);
  } catch (error) {
    setEngine(false, 'Install yt-dlp to continue');
    setMessage(error.message, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  inspectButton.disabled = true;
  inspectButton.innerHTML = 'Checking… <span>↻</span>';
  $('inspectStatus').textContent = 'Reading link details';
  setMessage('');
  try {
    if (demoMode) {
      setMessage('Run the desktop app to inspect this link and save media on your device.', 'notice');
      $('inspectStatus').textContent = 'Desktop app required';
      return;
    }
    currentMedia = await api.inspectUrl(url);
    $('mediaTitle').textContent = currentMedia.title;
    $('mediaMeta').textContent = `${currentMedia.channel} · ${formatDuration(currentMedia.duration)}`;
    preview.hidden = false;
    options.hidden = false;
    $('inspectStatus').textContent = 'Link details ready';
    if (demoMode) setMessage('Preview mode: install and launch the desktop app to inspect real links.', 'notice');
    urlInput.blur();
  } catch (error) {
    currentMedia = null;
    preview.hidden = true;
    options.hidden = true;
    $('inspectStatus').textContent = 'Could not read link';
    setMessage(error.message || 'Could not inspect this link.', 'error');
  } finally {
    inspectButton.disabled = false;
    inspectButton.innerHTML = 'Inspect link <span>→</span>';
  }
});

$('clearPreview').addEventListener('click', () => {
  currentMedia = null;
  preview.hidden = true;
  options.hidden = true;
  urlInput.focus();
});

$('folderButton').addEventListener('click', async () => {
  if (!api) {
    setMessage('Folder selection is available in the desktop app.', 'notice');
    return;
  }
  try {
    const folder = await api.chooseFolder();
    if (folder) {
      outputDirectory = folder;
      $('folderName').textContent = folder.split(/[\\/]/).filter(Boolean).at(-1) || folder;
      $('folderButton').title = folder;
    }
  } catch (error) {
    setMessage(error.message || 'Could not open the folder chooser.', 'error');
  }
});

$('downloadButton').addEventListener('click', async () => {
  if (!currentMedia) return;
  if (!api) {
    setMessage('Install the desktop app and yt-dlp to save media.', 'notice');
    return;
  }
  $('downloadButton').disabled = true;
  progressArea.hidden = false;
  runningTitle = currentMedia.title;
  $('progressTitle').textContent = runningTitle;
  $('progressMessage').textContent = 'Starting download…';
  $('progressPercent').textContent = '—';
  $('progressBar').style.width = '2%';
  $('progressTrack').removeAttribute('aria-valuenow');
  try {
    startingDownload = true;
    const result = await api.startDownload({
      url: currentMedia.url,
      quality: qualitySelect.value,
      outputDirectory,
    });
    runningId = result.id;
    const pendingProgress = earlyProgress.get(runningId);
    const pendingFinished = earlyFinished.get(runningId);
    earlyProgress.delete(runningId);
    earlyFinished.delete(runningId);
    if (pendingProgress) updateProgress(pendingProgress);
    if (pendingFinished) finishDownload(pendingFinished);
  } catch (error) {
    $('downloadButton').disabled = false;
    progressArea.hidden = true;
    setMessage(error.message || 'Could not start the download.', 'error');
  } finally {
    startingDownload = false;
  }
});

$('cancelButton').addEventListener('click', async () => {
  if (!runningId) {
    progressArea.hidden = true;
    $('cancelButton').textContent = 'Cancel';
    return;
  }
  if (runningId && api) await api.cancelDownload(runningId);
  $('progressMessage').textContent = 'Stopping…';
});

if (api) {
  api.onProgress((event) => {
    if (event.id !== runningId) {
      if (startingDownload) earlyProgress.set(event.id, event);
      return;
    }
    updateProgress(event);
  });
  api.onFinished((event) => {
    if (event.id !== runningId) {
      if (startingDownload) earlyFinished.set(event.id, event);
      return;
    }
    finishDownload(event);
  });
}

function updateProgress(event) {
    $('progressMessage').textContent = event.message || 'Downloading…';
    if (event.percent !== null) {
      $('progressBar').style.width = `${Math.max(2, Math.min(100, event.percent))}%`;
      $('progressPercent').textContent = `${event.percent.toFixed(1)}%`;
      $('progressTrack').setAttribute('aria-valuenow', String(Math.round(event.percent)));
    }
}

function finishDownload(event) {
    runningId = null;
    $('downloadButton').disabled = false;
    $('cancelButton').textContent = 'Close';
    if (event.ok) {
      $('progressBar').style.width = '100%';
      $('progressPercent').textContent = 'Done';
      $('progressMessage').textContent = `Saved in ${$('folderName').textContent}`;
      let items = [];
      try { items = JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch { items = []; }
      items.unshift({ title: runningTitle || 'Downloaded media', meta: new Date().toLocaleDateString() });
      try { localStorage.setItem(historyKey, JSON.stringify(items.slice(0, 20))); } catch { /* Keep the completed download even when storage is full. */ }
      loadLibrary();
    } else {
      $('progressMessage').textContent = event.error || 'Download stopped.';
      $('progressPercent').textContent = 'Stopped';
    }
}

loadLibrary();
checkEngine();
