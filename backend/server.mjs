import http from 'node:http';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';

const port = Number(process.env.PORT || 10000);
const ytdlp = process.env.FRAMEHARBOR_YTDLP || 'yt-dlp';
const workingDirectory = process.env.FRAMEHARBOR_TEMP_DIR || tmpdir();
const maxBodyBytes = 16 * 1024;
const maxInfoBytes = 8 * 1024 * 1024;
const maxDownloadBytes = Number(process.env.FRAMEHARBOR_MAX_DOWNLOAD_BYTES || 262144000);
const maxDurationSeconds = 45 * 60;
const maxDownloadMs = 5 * 60 * 1000;
const maxConcurrentJobs = 2;
const allowlistedDomains = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'vimeo.com',
  'reddit.com', 'v.redd.it',
  'instagram.com',
  'tiktok.com',
  'x.com', 'twitter.com',
  'dailymotion.com',
  'soundcloud.com',
];
const allowedOrigins = new Set([
  'https://all-video-downloader-orcin.vercel.app',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
]);
const rateLimits = new Map();
const activeByIp = new Map();
let activeJobs = 0;
let cachedYtdlpVersion = '';
let cachedFfmpegVersion = '';
let lastVersionCheck = 0;

const mimeTypes = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ts: 'video/mp2t',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
};
const supportedExtensions = new Set(Object.keys(mimeTypes));
const qualityCaps = { best: Infinity, '1080': 1080, '720': 720, '480': 480 };

function setCommonHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return false;
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-FrameHarbor-Estimated-Bytes');
  response.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function getClientIp(request) {
  // Render's Cloudflare edge overwrites this header; X-Forwarded-For can contain client-supplied entries.
  const clientIp = String(request.headers['cf-connecting-ip'] || '').trim();
  return isIP(clientIp) ? clientIp : request.socket.remoteAddress || 'unknown';
}

function takeRateLimit(ip, kind) {
  const now = Date.now();
  let record = rateLimits.get(ip);
  if (!record || now - record.startedAt >= 10 * 60 * 1000) {
    record = { startedAt: now, inspect: 0, download: 0 };
    rateLimits.set(ip, record);
  }
  const max = kind === 'download' ? 4 : 16;
  record[kind] += 1;
  return record[kind] <= max;
}

function acquireJob(ip) {
  const ownJobs = activeByIp.get(ip) || 0;
  if (activeJobs >= maxConcurrentJobs || ownJobs >= 1) return false;
  activeJobs += 1;
  activeByIp.set(ip, ownJobs + 1);
  return true;
}

function releaseJob(ip) {
  activeJobs = Math.max(0, activeJobs - 1);
  const ownJobs = activeByIp.get(ip) || 0;
  if (ownJobs <= 1) activeByIp.delete(ip);
  else activeByIp.set(ip, ownJobs - 1);
}

function parseMediaUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) {
    const error = new Error('Paste a complete public video link under 4,096 characters.');
    error.status = 400;
    throw error;
  }
  let url;
  try { url = new URL(input.trim()); } catch {
    const error = new Error('Paste a complete video link first.');
    error.status = 400;
    throw error;
  }
  if (!['https:', 'http:'].includes(url.protocol) || !['', '80', '443'].includes(url.port) || url.username || url.password || !allowlistedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    const error = new Error('Use a public link from a supported video site.');
    error.status = 400;
    throw error;
  }
  url.hash = '';
  return url.toString();
}

async function readJson(request) {
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    const error = new Error('Send the request as JSON.');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('The request is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    const error = new Error('The request body is not valid JSON.');
    error.status = 400;
    throw error;
  }
}

function runYtDlp(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, ['--ignore-config', '--no-cache-dir', '--no-warnings', '--no-playlist', ...args], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    let outputBytes = 0;
    let errorText = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        const error = new Error('The source took too long to inspect. Try again.');
        error.status = 504;
        reject(error);
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxInfoBytes) {
        child.kill('SIGTERM');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const error = new Error('The source returned too much link data.');
          error.status = 413;
          reject(error);
        }
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorText = (errorText + chunk.toString()).slice(-8192);
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const error = new Error(cause.code === 'ENOENT' ? 'The download service is starting up. Please retry shortly.' : 'The source could not be reached.');
      error.status = cause.code === 'ENOENT' ? 503 : 502;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else {
        const text = errorText.toLowerCase();
        const error = new Error(text.includes('unsupported url') ? 'This link is not supported right now.' : 'The source could not provide this video. Check that the link is public and try again.');
        error.status = 422;
        reject(error);
      }
    });
  });
}

function getFfmpegVersion(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('FFmpeg is taking too long to start.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(0, 4096);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) resolve(output.split(/\r?\n/, 1)[0].replace(/^ffmpeg version\s*/i, ''));
      else reject(new Error('FFmpeg is unavailable.'));
    });
  });
}

async function extractMedia(url) {
  const output = await runYtDlp(['--dump-single-json', '--skip-download', '--', url]);
  let info;
  try { info = JSON.parse(output); } catch {
    const error = new Error('The source returned link details in an unexpected format.');
    error.status = 502;
    throw error;
  }
  if (Number.isFinite(info.duration) && info.duration > maxDurationSeconds) {
    const error = new Error('Web downloads are limited to videos under 45 minutes. Use the desktop app for longer videos.');
    error.status = 413;
    throw error;
  }
  const formats = selectFormats(info);
  return { info, formats };
}

async function inspectMedia(url) {
  const { info, formats } = await extractMedia(url);
  if (!formats.best) {
    const error = new Error('This link has no browser-compatible video format. Try the desktop app.');
    error.status = 422;
    throw error;
  }
  return {
    title: info.title || 'Untitled video',
    channel: info.uploader || info.channel || info.extractor_key || 'Online media',
    duration: Number.isFinite(info.duration) ? info.duration : null,
    thumbnail: null,
    url,
    formats: Object.fromEntries(Object.entries(formats).map(([quality, format]) => [quality, format && {
      height: Number.isFinite(format.height) ? format.height : null,
      ext: format.fileExt,
      estimatedBytes: format.size,
    }])),
  };
}

function selectFormats(info) {
  const formats = (Array.isArray(info.formats) ? info.formats : [info])
    .filter((format) => format && format.url && format.format_id && ['http', 'https', 'http_dash_segments', 'm3u8', 'm3u8_native'].includes(format.protocol));
  const compatibleFormats = formats
    .filter((format) => format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none' && supportedExtensions.has(format.ext))
    .map((format) => ({
      formatId: format.format_id,
      height: Number.isFinite(format.height) ? format.height : null,
      ext: format.ext,
      fileExt: String(format.protocol).startsWith('m3u8') ? 'ts' : format.ext,
      mode: String(format.protocol).startsWith('m3u8') ? 'ffmpeg' : 'direct',
      size: format.filesize || format.filesize_approx || null,
      tbr: Number(format.tbr) || 0,
    }));
  const videoOnly = formats.filter((format) => format.vcodec && format.vcodec !== 'none' && (!format.acodec || format.acodec === 'none') && ['mp4', 'webm'].includes(format.ext));
  const audioOnly = formats.filter((format) => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none'));
  for (const video of videoOnly) {
    const matchingAudio = audioOnly.filter((audio) => video.ext === 'mp4'
      ? ['m4a', 'mp4'].includes(audio.ext) && /^(mp4a|aac)/i.test(audio.acodec)
      : audio.ext === 'webm' && /^(opus|vorbis)/i.test(audio.acodec));
    for (const audio of matchingAudio) {
      const videoSize = video.filesize || video.filesize_approx || null;
      const audioSize = audio.filesize || audio.filesize_approx || null;
      const size = videoSize && audioSize ? videoSize + audioSize : videoSize || audioSize;
      if (Number.isFinite(size) && size > maxDownloadBytes) continue;
      compatibleFormats.push({
        formatId: `${video.format_id}+${audio.format_id}`,
        height: Number.isFinite(video.height) ? video.height : null,
        ext: video.ext,
        fileExt: String(video.protocol).startsWith('m3u8') || String(audio.protocol).startsWith('m3u8') || video.ext === 'mp4' ? 'ts' : 'webm',
        mode: 'ffmpeg',
        size,
        tbr: (Number(video.tbr) || 0) + (Number(audio.tbr) || 0),
      });
    }
  }
  const byQuality = {};
  for (const [quality, cap] of Object.entries(qualityCaps)) {
    const candidates = compatibleFormats.filter((format) => quality === 'best' || (Number.isFinite(format.height) && format.height <= cap));
    candidates.sort((a, b) => {
      const extRank = (ext) => ext === 'mp4' ? 0 : ext === 'webm' ? 1 : 2;
      return (Number(b.height) || 0) - (Number(a.height) || 0)
        || b.tbr - a.tbr
        || extRank(a.ext) - extRank(b.ext);
    });
    byQuality[quality] = candidates.find((format) => !Number.isFinite(format.size) || format.size <= maxDownloadBytes) || null;
  }
  return byQuality;
}

function safeFilename(value, extension) {
  const base = String(value || 'FrameHarbor video')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || 'FrameHarbor video';
  const ascii = base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const filename = `${base}.${extension}`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${encoded}`;
}

function startDownload(request, response, ip, input) {
  const url = parseMediaUrl(input.url);
  const quality = String(input.quality || 'best');
  if (!Object.hasOwn(qualityCaps, quality)) {
    const error = new Error('Choose a supported quality.');
    error.status = 400;
    throw error;
  }
  if (!acquireJob(ip)) {
    const error = new Error('The service is busy. Wait for the current download to finish and retry.');
    error.status = 429;
    throw error;
  }

  let child;
  let timer;
  let startedResponse = false;
  let completed = false;
  let bytesSent = 0;
  let timedOut = false;
  const cleanup = () => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    releaseJob(ip);
  };
  const fail = (status, message) => {
    cleanup();
    if (startedResponse) response.destroy();
    else sendJson(response, status, { error: message });
  };

  extractMedia(url).then(({ info, formats }) => {
    if (response.destroyed || request.aborted) {
      cleanup();
      return;
    }
    const format = formats[quality];
    if (!format) {
      fail(422, 'That quality is not available for this link. Choose a lower quality.');
      return;
    }
    child = spawn(ytdlp, [
      '--ignore-config', '--no-cache-dir', '--no-warnings', '--no-playlist', '--no-progress',
      ...(format.mode === 'ffmpeg' ? ['--downloader', 'ffmpeg'] : []),
      '--format', format.formatId, '--output', '-', '--', url,
    ], { cwd: workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, maxDownloadMs);

    child.stderr.resume();
    child.on('error', () => fail(503, 'The download service could not start this transfer.'));
    child.stdout.on('data', (chunk) => {
      if (completed) return;
      bytesSent += chunk.length;
      if (bytesSent > maxDownloadBytes) {
        child.kill('SIGTERM');
        fail(413, 'This file exceeds the web download limit. Use the desktop app for larger files.');
        return;
      }
      if (!startedResponse) {
        startedResponse = true;
        response.writeHead(200, {
          'Content-Type': mimeTypes[format.fileExt] || 'application/octet-stream',
          'Content-Disposition': safeFilename(info.title, format.fileExt),
          'X-FrameHarbor-Estimated-Bytes': String(format.size || ''),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
      }
      if (!response.write(chunk)) child.stdout.pause();
    });
    response.on('drain', () => child?.stdout.resume());
    request.on('aborted', () => child?.kill('SIGTERM'));
    response.on('close', () => {
      if (!response.writableEnded) child?.kill('SIGTERM');
      cleanup();
    });
    child.on('close', (code) => {
      if (completed) return;
      clearTimeout(timer);
      if (!startedResponse) {
        fail(timedOut ? 504 : code === 0 ? 502 : 422, timedOut ? 'The source took too long to download. Try a shorter video.' : 'The source could not provide this video. Check that the link is public and try again.');
        return;
      }
      if (code !== 0) {
        fail(timedOut ? 504 : 502, timedOut ? 'The source took too long to download. Try a shorter video.' : 'The transfer was interrupted by the source.');
        return;
      }
      cleanup();
      response.end();
    });
  }).catch((error) => fail(error.status || 502, error.message || 'Could not prepare this download.'));
}

const server = http.createServer(async (request, response) => {
  setCommonHeaders(response);
  if (!setCors(request, response)) {
    sendJson(response, 403, { error: 'This site is not allowed to use the download service.' });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'GET' && pathname === '/health') {
    try {
      if (!cachedYtdlpVersion || !cachedFfmpegVersion || Date.now() - lastVersionCheck > 5 * 60 * 1000) {
        cachedYtdlpVersion = (await runYtDlp(['--version'], 10000)).trim();
        cachedFfmpegVersion = await getFfmpegVersion();
        lastVersionCheck = Date.now();
      }
      sendJson(response, 200, { ok: true, service: `yt-dlp ${cachedYtdlpVersion} · FFmpeg ${cachedFfmpegVersion}` });
    } catch {
      cachedYtdlpVersion = '';
      cachedFfmpegVersion = '';
      sendJson(response, 503, { ok: false, error: 'The download engine is not ready.' });
    }
    return;
  }
  if (!['/api/inspect', '/api/download'].includes(pathname) || request.method !== 'POST') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  const ip = getClientIp(request);
  const kind = pathname.endsWith('/download') ? 'download' : 'inspect';
  if (!takeRateLimit(ip, kind)) {
    sendJson(response, 429, { error: 'You have reached the request limit. Please wait a few minutes and try again.' });
    return;
  }

  let input;
  try { input = await readJson(request); } catch (error) {
    sendJson(response, error.status || 400, { error: error.message });
    return;
  }

  if (kind === 'download') {
    try { startDownload(request, response, ip, input); } catch (error) {
      sendJson(response, error.status || 400, { error: error.message });
    }
    return;
  }

  if (!acquireJob(ip)) {
    sendJson(response, 429, { error: 'The service is busy. Wait a moment and retry.' });
    return;
  }
  try {
    const url = parseMediaUrl(input.url);
    const media = await inspectMedia(url);
    sendJson(response, 200, media);
  } catch (error) {
    sendJson(response, error.status || 502, { error: error.message || 'Could not inspect this link.' });
  } finally {
    releaseJob(ip);
  }
});

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, record] of rateLimits) {
    if (record.startedAt < cutoff) rateLimits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`FrameHarbor API listening on 0.0.0.0:${port}`);
});
