# Screening Room

Browse, stream, download and delete the media your downloader bot saves on your VPS.

## Run on your computer
1. `cp .env.example .env` (check VPS_KEY points at your .pem)
2. `npm install`
3. `npm run dev` → open http://localhost:5173

Production build: `npm run build && npm start` → http://localhost:3001

## Put it online (recommended: on the VPS itself, not Vercel)
- Set `APP_PASSWORD` in `.env`, then run `npm run build && npm start` on the VPS (use pm2 or systemd).
- HTTPS option 1: a domain (a free DuckDNS name works) pointing to the VPS, then Caddy:
  `your.domain { reverse_proxy 127.0.0.1:3001 }` (certificates are automatic; ports 80 and 443 must be open).
- HTTPS option 2, no domain: `cloudflared tunnel --url http://127.0.0.1:3001`.
- No HTTPS at all: `ssh -i ~/.ssh/Traqor.pem -L 3001:127.0.0.1:3001 root@139.162.182.113`, then open http://localhost:3001.

## Needs on the VPS
ffmpeg (for the 4K/1080p/720p conversions; "Original" needs nothing). `zip` is optional.
