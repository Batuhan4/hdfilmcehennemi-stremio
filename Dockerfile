# HDFilmCehennemi Stremio addon.
# curl is baked in (needed for the Cloudflare JA3 fallback on /dizi/ pages),
# and deps are installed at build time so the container starts with just `node`.
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "addon.js"]
