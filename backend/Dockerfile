FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]'

WORKDIR /app
COPY backend/server.mjs ./server.mjs

ENV NODE_ENV=production
ENV FRAMEHARBOR_YTDLP=/opt/yt-dlp/bin/yt-dlp
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.mjs"]
