# Cinema for your VPS: the same app, running on the server next to your videos, so phones and TVs can use it with the laptop off.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=optional
COPY . .
RUN npm run build && npm run build:server

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV MODE=local BIND=0.0.0.0 PORT=3001 CINEMA_DATA=/data TRUST_PROXY=1
VOLUME /data
USER node
EXPOSE 3001
CMD ["node", "dist-server/server.cjs"]
