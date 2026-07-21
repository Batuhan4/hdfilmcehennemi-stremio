# HDFilmCehennemi Stremio addon.
# curl is baked in (needed for the Cloudflare JA3 fallback on /dizi/ pages),
# ffmpeg is baked in (server-side mux for dual-language titles via /proxy/mux),
# and deps are installed at build time so the container starts with just `node`.
#
# node:22-alpine tracks the latest alpine, which ships ffmpeg 8.1.2 (2026) —
# the newest ffmpeg, per the user's "latest everything" preference. The mux
# path relies on 7.1+ behaviour: -extension_picky 0 (added 7.1) so ffmpeg
# accepts the CDN's fake ".jpg" segment names. 8.1.2 supports it.
#
# The base is intentionally floating-latest here. To stay robust across ffmpeg
# versions anyway, the addon PROBES at startup whether ffmpeg accepts
# -extension_picky and only passes the flag when supported (older alpine tags
# like 3.21/3.22 ship ffmpeg 6.1.2, which lacks the option and doesn't need it).
# If a future ffmpeg changes HLS demuxer behaviour, re-test /proxy/mux end to
# end inside the built container image (not the host ffmpeg).
FROM node:22-alpine
RUN apk add --no-cache curl ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "addon.js"]
