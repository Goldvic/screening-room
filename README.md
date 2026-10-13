# Screening Room

Browse, stream, download and delete the media your downloader bot saves on your VPS.

## Run on your computer
1. `cp .env.example .env` (check VPS_KEY points at your .pem)
2. `npm install`
3. `npm run dev` → open http://localhost:5173

Production build: `npm run build && npm start` → http://localhost:3001

## What is in the player
- Your own controls: seek bar with buffer and hover time, volume, speed 0.5×–3×, fullscreen, picture-in-picture, screenshot, sleep timer, next episode.
- **Screen shape**: Fit, Fill (zoom to remove black bars), Stretch, or force 16:9, 21:9, 4:3, 1:1. Plus zoom, brightness, contrast, color.
- **Subtitles**: picks your language automatically from tracks inside the file or `.srt/.vtt/.ass` files next to the video. You can also load a file from your device, change size/color/background and shift the timing.
- **AI subtitles** (optional): generates them on the VPS with Whisper when a video has none. See below.
- **Sound**: volume boost up to 300% and a night mode that evens out loud and quiet parts.
- **Quality**: *Auto* (adaptive, see below), Original, *Original + fixed audio* (copies the video, converts only the audio, fixes silent MKV files), or a locked size from 360p to 4K.
- **Seek-bar previews**: hover or drag the seek bar to see a thumbnail of that moment. The server builds one small sheet of frames per video the first time you hover (a few seconds to a minute, only key frames are read), then keeps it.
- **Network status**: live speed (KB/s or MB/s and Mbps), data used by this video, data used today and in total (press `I` in the player, or see the card in the sidebar).
- Keys: Space play, ←/→ 10 s, ↑/↓ volume, F fullscreen, C subtitles, A screen shape, < > speed, 0–9 jump, N next, I stats, S screenshot, P picture-in-picture. In the library press `/` to search.

## Auto quality (adaptive streaming)
Pick **Quality → Auto**. The server cuts the video into 6-second pieces at 360p, 480p, 720p, 1080p (and up, never above the source) as the player asks for them, and the player switches level by itself when your connection speeds up or slows down. Seeking is instant and works anywhere in the video. Locked sizes (720p and so on) use the same system with a single level.

Things worth knowing:
- Every Auto level is converted on the VPS, so Auto never equals the untouched original. Use **Original** when your connection can take it; if the original keeps pausing, the player offers to switch to Auto.
- It needs CPU: roughly one fast core per stream at 1080p. `HLS_JOBS` (default 2) limits how many pieces are converted at once, and `HLS_CACHE_MB` (default 256) keeps recent pieces in memory so rewinding is free. If the VPS is too slow, Auto simply settles on a lower level.
- It uses `hls.js`, so run `npm install` once after updating (use `npm install`, not `npm ci`, because the lock file changed).

## Making it fast
Speed from VPS to your screen is the lowest of four things: the disk, this app, the VPS network port, and your own internet line. The app handles the first two; the Settings → Speed test button shows you the other two.

1. **Run the app on the VPS itself.** When `VPS_HOST` is one of the machine's own addresses (or you set `MODE=local`) the app reads the disk directly and skips SSH completely. The server log says `LOCAL disk mode` when this is active.
2. If it runs elsewhere, SSH mode now keeps many read requests in flight and uses the fastest cipher, instead of one request at a time.
3. **Turbo download** (Settings → Downloads): big files are fetched over 2–16 parallel connections and written straight to disk. A single TCP connection often cannot fill a fast line over long distances; several can. Works in Chrome, Edge and Opera over HTTPS or localhost. Other browsers fall back to a normal download.
4. Turn on **BBR** on the VPS, which helps every single-connection transfer:
   ```
   echo "net.core.default_qdisc=fq" | sudo tee -a /etc/sysctl.conf
   echo "net.ipv4.tcp_congestion_control=bbr" | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```
5. Use Caddy (below) rather than a tunnel for the best speed. Cloudflare tunnels and similar add limits.

About 10 Gbps: no app can promise that. It only happens if your VPS plan has a 10 Gbps port **and** your own connection and device can take it. Run the speed test to see what your real path delivers.

## AI subtitles (optional)
On the VPS: `pip install whisper-ctranslate2` (needs ffmpeg). Then use **Subtitles → Generate subtitles with AI** in the player. The first run downloads the model. On a CPU-only VPS a full movie can take from a few minutes to hours depending on the model (`WHISPER_MODEL=tiny|base|small`), and it runs at low priority so streaming keeps working.

## Put it online (recommended: on the VPS itself, not Vercel)
- Set `APP_PASSWORD` in `.env`, then run `npm run build && npm start` on the VPS (use pm2 or systemd).
- HTTPS option 1: a domain (a free DuckDNS name works) pointing to the VPS, then Caddy:
  `your.domain { reverse_proxy 127.0.0.1:3001 }` (certificates are automatic; ports 80 and 443 must be open).
- HTTPS option 2, no domain: `cloudflared tunnel --url http://127.0.0.1:3001`.
- No HTTPS at all: `ssh -i ~/.ssh/Traqor.pem -L 3001:127.0.0.1:3001 root@139.162.182.113`, then open http://localhost:3001.

## Needs on the VPS
ffmpeg and ffprobe (conversions, thumbnails, subtitles; "Original" playback needs nothing). `zip` is optional (folder downloads). Whisper is optional (AI subtitles).