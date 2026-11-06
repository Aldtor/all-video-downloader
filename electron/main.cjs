const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const activeDownloads = new Map();
const appPagePath = path.resolve(__dirname, '..', 'app', 'index.html');
const websitePagePath = path.resolve(__dirname, '..', 'website', 'index.html');
const appPageUrl = pathToFileURL(appPagePath).href;
const allowedLocalPages = new Set([appPageUrl, pathToFileURL(websitePagePath).href]);
const selectors = {
  best: 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
  '1080': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720': 'bv*[height<=720]+ba/b[height<=720]',
  '480': 'bv*[height<=480]+ba/b[height<=480]',
};

function ytDlpExecutable() {
  const configured = process.env.FRAMEHARBOR_YTDLP;
  if (configured) return configured;

  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'tools', binaryName),
    path.join(__dirname, '..', 'tools', binaryName),
  ].filter(Boolean);
  const bundled = candidates.find((candidate) => fs.existsSync(candidate));
  if (bundled) return bundled;

  return binaryName;
}

function assertTrustedSender(event) {
  let senderUrl = '';
  try {
    const parsed = new URL(event.senderFrame?.url || '');
    parsed.hash = '';
    senderUrl = parsed.href;
  } catch {
    senderUrl = '';
  }
  if (senderUrl !== appPageUrl) {
    throw new Error('This action is only available from the FrameHarbor desktop window.');
  }
}

function parseUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) {
    throw new Error('Paste a valid link under 4,096 characters.');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Paste a complete video or playlist link first.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use a public http or https link.');
  }
  return url.toString();
}

function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpExecutable(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflowed = false;
    const timeout = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error('The link took too long to inspect. Try again.'));
      }
    }, options.timeout || 120000);

    child.stdout.on('data', (chunk) => {
      const maxBuffer = options.maxBuffer || 32 * 1024 * 1024;
      if (stdout.length + chunk.length > maxBuffer) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (error.code === 'ENOENT') reject(new Error('yt-dlp is not installed or is not on PATH. See the setup notes on the website.'));
      else reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (overflowed) reject(new Error('The link returned too much metadata to inspect.'));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'yt-dlp could not process this link.'));
    });
  });
}

function openWindow() {
  const window = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 640,
    backgroundColor: '#f5f6f4',
    title: 'FrameHarbor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    let normalizedUrl = targetUrl;
    try {
      const parsed = new URL(targetUrl);
      parsed.hash = '';
      normalizedUrl = parsed.href;
    } catch {
      event.preventDefault();
      return;
    }
    if (!allowedLocalPages.has(normalizedUrl)) event.preventDefault();
  });
  window.loadFile(appPagePath);
}

app.whenReady().then(() => {
  ipcMain.handle('engine:status', async (event) => {
    assertTrustedSender(event);
    const { stdout } = await runYtDlp(['--version'], { timeout: 15000, maxBuffer: 4096 });
    return { version: stdout.trim() };
  });

  ipcMain.handle('folder:choose', async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: 'Choose a save folder',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('url:inspect', async (event, input) => {
    assertTrustedSender(event);
    const url = parseUrl(input);
    const { stdout } = await runYtDlp(['--ignore-config', '--dump-single-json', '--no-warnings', '--skip-download', '--no-playlist', '--', url]);
    let info;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new Error('yt-dlp returned video details in an unexpected format.');
    }
    return {
      title: info.title || 'Untitled media',
      channel: info.uploader || info.channel || info.extractor_key || 'Online media',
      duration: Number.isFinite(info.duration) ? info.duration : null,
      thumbnail: info.thumbnail || null,
      url,
    };
  });

  ipcMain.handle('download:start', async (event, request) => {
    assertTrustedSender(event);
    const url = parseUrl(request?.url);
    const quality = String(request?.quality || 'best');
    const outputDirectory = path.resolve(String(request?.outputDirectory || app.getPath('downloads')));
    if (!['best', '1080', '720', '480'].includes(quality)) throw new Error('Choose a supported quality.');
    if (!path.isAbsolute(outputDirectory)) throw new Error('Choose a valid save folder.');
    let directoryInfo;
    try {
      directoryInfo = await fs.promises.stat(outputDirectory);
    } catch {
      throw new Error('The chosen save folder is no longer available. Choose it again.');
    }
    if (!directoryInfo.isDirectory()) throw new Error('Choose a folder for the downloaded file.');

    const id = randomUUID();
    const args = [
      '--ignore-config', '--no-warnings', '--newline', '--progress',
      '-f', selectors[quality],
      '-P', outputDirectory,
      '-o', '%(title)s [%(id)s].%(ext)s',
      '--no-playlist', '--', url,
    ];
    const child = spawn(ytDlpExecutable(), args, { windowsHide: true });
    activeDownloads.set(id, child);

    let lineBuffer = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      activeDownloads.delete(id);
      if (!event.sender.isDestroyed()) event.sender.send('download:finished', { id, ...result });
    };
    const sendLines = (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(/(\d+(?:\.\d+)?)%/);
        if (!event.sender.isDestroyed()) event.sender.send('download:progress', {
          id,
          percent: match ? Number(match[1]) : null,
          message: line.replace(/^\[download\]\s*/, '').trim(),
        });
      }
    };
    child.stdout.on('data', sendLines);
    child.stderr.on('data', sendLines);
    child.on('error', (error) => {
      finish({
        ok: false,
        error: error.code === 'ENOENT' ? 'yt-dlp was not found. Install it or set FRAMEHARBOR_YTDLP.' : error.message,
      });
    });
    child.on('close', (code) => {
      if (lineBuffer.trim()) sendLines('\n');
      finish({
        ok: code === 0,
        error: code === 0 ? null : 'Download stopped. Review the last status message and try again.',
      });
    });
    return { id };
  });

  ipcMain.handle('download:cancel', async (_event, id) => {
    assertTrustedSender(_event);
    const child = activeDownloads.get(String(id));
    if (!child) return false;
    child.kill();
    return true;
  });

  openWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const child of activeDownloads.values()) child.kill();
  activeDownloads.clear();
});
