# FrameHarbor

FrameHarbor is a fresh, local-first media downloader project with a companion landing page. It uses an original UI and application shell. The downloader calls `yt-dlp` as a separate program installed on your computer; it does not upload media through a FrameHarbor server.

**Working name:** FrameHarbor. Search results did not show an obvious exact-match product, but this is not trademark clearance.

## Run the website

The website and desktop UI preview use Node's built-in HTTP server, so no website packages are needed:

```powershell
cd "D:\ChatGPT\VIedo down all\FrameHarbor"
npm run web
```

Open `http://127.0.0.1:4173`. The tool page is at `http://127.0.0.1:4173/tool/`; the desktop UI preview is at `http://127.0.0.1:4173/desktop/`. Real link inspection and downloads are available only in the Electron app.

## Deploy the website

The repository includes `vercel.json` rewrites for the landing page at `/`, the tool page at `/tool/`, and the desktop UI preview at `/desktop/`. Point a Vercel project at the `FrameHarbor` folder and deploy it as a static site. The same files can be hosted by another static host if it supports equivalent route rewrites.

## Run the desktop app

Install the current Electron dependency, then launch the app:

```powershell
npm install
npm start
```

Install [`yt-dlp`](https://github.com/yt-dlp/yt-dlp/releases/latest) separately and make sure it is available on `PATH`. You can set `FRAMEHARBOR_YTDLP` to the full executable path instead. For merging separate video and audio streams, install FFmpeg and make it available on `PATH` too.

## Notes before distribution

- The current project is a development starter; signed installers and release downloads are not configured yet.
- Keep `yt-dlp` and FFmpeg as separate dependencies and include their current license notices if you bundle them later.
- Only save media that you own or have permission to download, and follow each site's terms.
- This project was created separately from the YT-Forge source. The YT-Forge app license allows noncommercial purposes, and its website repository contains no license file, so neither source is included here.
