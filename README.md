# Cinema

Watch the movies and series on your VPS from your laptop: stream them, or save them for offline and watch with no internet.
It started as "Screening Room" (a web app) and is now also a desktop app with an installer.

## Run it

```
npm install
npm run app          # builds and opens the desktop app
```

Develop with live reload: `npm run app:dev`. The old browser version still works: `npm run dev`.

## Make the Windows installer

```
npm run dist
```

The installer appears in `release/` (`Cinema-Setup-1.0.0.exe`). Build it on Windows to get the Windows ffmpeg inside.
`npm run dist:mac` and `npm run dist:linux` do the same on those systems.
The installer is not code-signed, so Windows SmartScreen shows a warning the first time ("More info" > "Run anyway").

## First start

1. Open **Servers** (the first start shows it automatically) and fill in your VPS address, user and SSH key (or password).
2. Press **Test connection**, then **Save**.
3. Your movies appear. Nothing is stored in the installer: keys and passwords are encrypted with your Windows account.

## What it does

**Offline.** The save icon (or *Save for offline* inside the player) puts a movie or a whole folder in the download queue.
Downloads resume after a break, can be limited in speed, scheduled for the night and paused when your monthly data budget is used.
Thumbnails, seek previews and subtitles are saved too, so everything works with no internet.
Your files go to `Videos\Cinema` (change it in Settings). **Storage** shows what takes space and can delete watched videos.

**Smaller files.** When saving you can have the server make the file smaller first (720p, 480p, 360p; H.264, HEVC or AV1).
This runs once on the VPS, then only the small file is downloaded. HEVC/AV1 appear only if both the server and this laptop support them.
You can also mix 5.1 down to stereo with louder dialogue, or even out the loudness.

**Less data when streaming.** *Data Saver* (Off / Balanced / Low / Ultra) caps what Auto quality may pick, lowers the bitrate,
stops downloading ahead while paused and skips the seek previews. *Audio only* uses almost no data.
With a monthly budget set, Data Saver moves to Low at 80%.

**Sound.** The volume slider goes to 500% (mouse wheel and arrow keys too). A limiter and soft clipper keep it clean at high volume.
There is a 10-band equalizer with presets, dialogue boost, night mode, mono and an output device picker, remembered per video.
5.1 audio is mixed to stereo with the centre channel (voices) lifted. Very loud volume can hurt your ears: by default the volume goes back to 100% when the app restarts.

**Player.** Keyboard: Space, arrows, F, C (subtitles), G (sound), A (screen shape), `<` `>` (speed up to 4x), B (A-B loop), D (bookmark), E (next frame), 0-9 (jump), N (next), I (stats).
Chapters and *Skip intro*, bookmarks, online subtitle search (OpenSubtitles), AI subtitles (Whisper on the VPS), picture-in-picture, mini player that stays on top, screenshots,
rotate/flip/zoom/colors, sleep timer, media keys, and the laptop stays awake while playing.
*Open in another player* sends the video to VLC or any player you choose in Settings.

**Library.** Favorites, filters (not watched / watched / favorites), "Surprise me", Continue watching, optional posters and descriptions (free TMDB key).

## Open any video on your computer

You can play videos that are not in your server library, and they are never copied or moved:

- **Right-click a video in Explorer > Open with > Cinema**, or set Cinema as the default player for .mp4, .mkv and the others.
- **Drag videos onto the Cinema window** or onto its icon.
- **Open file…** in the sidebar, or press Ctrl+O.

They appear under **Opened files** in the sidebar, so Next, Continue watching and subtitles (a .srt next to the video is found automatically) all work.
Removing one from the list never deletes the video file. If Cinema is already running, the video opens in that window.

## Updates

The installed app can update itself from any web folder you control, for example one on your VPS.

1. Build the installer with `npm run dist`.
2. Upload these three files from `release/` to a folder on a web server: `Cinema-Setup-X.Y.Z.exe`, `Cinema-Setup-X.Y.Z.exe.blockmap` and `latest.yml`.
3. In Cinema open **Settings > Updates** and enter that folder's address (for example `https://example.com/cinema/`).

To publish a new version, raise `version` in `package.json`, run `npm run dist`, and upload the three new files over the old ones.
Cinema checks a few seconds after it starts and every 6 hours, shows an **Update available** card, downloads when you press Download,
and installs when you press **Restart and install** (or the next time you close the app). Nothing installs without you.
Updates work in the installed app only, not with `npm run app`.

## Offline playback and codecs

The player is Chromium. It plays H.264/AAC/VP9/AV1 anywhere. HEVC needs a laptop that can decode it.
AC3/DTS audio cannot be played by Chromium, so the player offers *Original + fixed audio*: online the VPS converts the sound,
offline the laptop does it with the ffmpeg that comes with the app. Compressed downloads already contain AAC sound.

## Security

- The desktop app only listens on `127.0.0.1` and requires a secret that only its own window has.
- SSH keys and passwords are encrypted with the operating system's keychain (Electron safeStorage).
- The browser version stores them obscured, not encrypted. Keep it on localhost, and set `APP_PASSWORD` if you ever expose it.

## Where things live

| What | Where |
|---|---|
| Settings, servers, queue, caches | `%APPDATA%\Cinema\data` |
| Downloaded videos | `Videos\Cinema` |
| Opened files list | `%APPDATA%\Cinema\data\opened.json` (only the list, never the videos) |
| Server code | `server/` (index.ts routes, downloads.ts queue, backend.ts SSH/SFTP, store.ts settings) |
| Web app | `src/` |
| Desktop shell | `electron/` |

To rename the app, change `APP_NAME` in `src/lib.tsx`, `productName` in `package.json` and `<title>` in `index.html`.