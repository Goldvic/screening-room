# Cinema on your VPS: phone and TV with the laptop off

This runs the same Cinema app on your VPS, next to your videos. Your phone, tablet and TV open it over the internet, so your laptop can stay off.

- **Owner password** (`ADMIN_PASSWORD`): the whole app, on any device.
- **Watch code** (`ACCESS_PIN`): browse, search, play, resume, favourites. Nothing else. No settings, servers, downloads or deleting, and this is enforced by the server, not just hidden in the screens.
- **Your videos are mounted read-only.** Cinema running on the VPS cannot change or delete them.

## What you need
1. A VPS with Docker and Docker Compose installed.
2. A web address pointing at the VPS (step 1 below). This is needed for `https`, so the code and your videos are not sent in the open.
3. Ports **80** and **443** open on the VPS firewall.

## Step 1. Get an address (free)
Go to **duckdns.org**, sign in, create a name such as `mycinema`, and set its IP to your VPS's public IP. Your address is then `mycinema.duckdns.org`. (Any domain you own works too: add an `A` record to the VPS IP.)

## Step 2. Put the project on the VPS
Copy the whole Cinema project folder to the VPS (git clone, or upload it). All commands below run inside that folder.

## Step 3. Fill in the settings
```
cp deploy/.env.example deploy/.env
nano deploy/.env
```
- `DOMAIN`: your address from step 1, without `https://`.
- `MEDIA_DIR`: the folder on the VPS that holds your videos, for example `/srv/media`.
- `MEDIA_ROOTS`: the names you want shown in Cinema, each pointing at a folder inside `MEDIA_DIR`, written with `/media/` at the front. Example: `Movies=/media/Movies,Shows=/media/Shows`.
- `ACCESS_PIN` and `ADMIN_PASSWORD`: choose both. Use a long password. The PIN can be shared with family, so use something you do not use anywhere else.

## Step 4. Start it
```
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```
The first run takes a few minutes. Then open `https://your-address` on your phone and enter your code.

## Using it
- **Phone:** open the address, sign in once, and the phone stays signed in for 60 days. In your phone's browser menu choose **Add to Home screen** to get an icon.
- **TV:** open the TV's web browser and go to `https://your-address/tv`. It shows a 6-letter code. On your phone, open a video, tap the cast button, and type the code once. Your TV stays paired.
- **Playing on the TV:** open any video on your phone, tap the cast button, then **Play this on your TV**. A small remote stays at the bottom of the phone while you keep browsing: play/pause, ±10 seconds, a seek bar, volume, next and previous, stop.

## Things to know
- **Watch history is kept where the app runs.** Phone and TV share their history with each other (both use the VPS copy). The Cinema app on your laptop keeps its own, separate history.
- **Your VPS does the work.** Videos your phone or TV can not play directly are converted on the VPS, which uses its processor. A small VPS handles one or two streams at once. Your VPS's upload speed sets the video quality you can watch.
- **Some TV browsers are old.** Android TV, Google TV, Fire TV and recent Samsung and LG sets work best. If your TV's browser is too old, the page tells you.
- **If someone guesses wrong codes,** that address is locked out for a while, longer each time.
- **To sign everybody out,** change `ACCESS_PIN` or `ADMIN_PASSWORD` and restart. All old sessions stop working.

## Everyday commands
```
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f cinema     # see what it is doing
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build      # update after changing the code
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down               # stop
```
Your history, favourites and TV pairings live in the `cinema-data` volume and survive updates.
