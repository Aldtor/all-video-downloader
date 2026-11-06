# FrameHarbor

FrameHarbor includes a browser tool and a local desktop app. The desktop app calls `yt-dlp` on your computer. The browser tool uses a separate streaming API: it sends public links to the API, which streams the requested media through the service to your browser without keeping a permanent copy.

**Working name:** FrameHarbor. Search results did not show an obvious exact-match product, but this is not trademark clearance.

## Run the website

The website and desktop UI preview use Node's built-in HTTP server, so no website packages are needed:

```powershell
cd "D:\ChatGPT\VIedo down all\FrameHarbor"
npm run web
```

Open `http://127.0.0.1:4173`. The browser tool is at `http://127.0.0.1:4173/tool/`; the desktop UI preview is at `http://127.0.0.1:4173/desktop/`.

## Deploy the website

The repository includes `vercel.json` rewrites for the landing page at `/`, the tool page at `/tool/`, and the desktop UI preview at `/desktop/`. Point a Vercel project at the `FrameHarbor` folder and deploy it as a static site. The same files can be hosted by another static host if it supports equivalent route rewrites.

## Deploy the browser download service

The browser tool needs its streaming API. The repository includes a Render Blueprint in `render.yaml`; deploy it with the button below, then keep its generated hostname as `frameharbor-all-video-downloader-api.onrender.com`, or update `website/api-config.js` if Render assigns a different hostname. Add any custom website domain to the service's `ALLOWED_ORIGINS` value.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Aldtor/all-video-downloader)

The API streams supported single-file formats directly and uses FFmpeg to combine separate audio and video tracks for compatible links. Web downloads are limited to 45 minutes and 250 MB. Media streams through the service to your browser; the API does not keep a permanent media copy.

The Blueprint uses Render's free service plan for a small personal preview. Free services sleep after 15 minutes without traffic and can take about a minute to wake. Downloads count toward monthly outbound bandwidth; exceeding the included amount can add charges when a payment method is on file, or suspend free services otherwise. Render advises against using free instances for production. Review the current [Render free plan limits](https://render.com/docs/free) before deploying. Blueprint auto-deploy is off, so deploy code changes manually from Render.

## Run the desktop app

Install the current Electron dependency, then launch the app:

```powershell
npm install
npm start
```

Install [`yt-dlp`](https://github.com/yt-dlp/yt-dlp/releases/latest) separately and make sure it is available on `PATH`. You can set `FRAMEHARBOR_YTDLP` to the full executable path instead. For merging separate video and audio streams, install FFmpeg and make it available on `PATH` too.

## Notes before distribution

- The current project is a development starter; signed installers and release downloads are not configured yet.
- Keep the desktop app's `yt-dlp` dependency separate and include its current license notices if you bundle it later.
- The web API is publicly callable; CORS does not authenticate clients. Add a challenge, durable quotas, and outbound network protections before broad public use.
- Only save media that you own or have permission to download, and follow each site's terms.
- This project was created separately from the YT-Forge source. The YT-Forge app license allows noncommercial purposes, and its website repository contains no license file, so neither source is included here.
