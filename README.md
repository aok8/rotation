# rotation

A small, self-hosted Spotify playlist player for listening through a shuffled source playlist and clearing tracks as you go. Choose an optional history playlist, then **Remove and skip** archives the current track first and removes it from the source after the archive succeeds. Spotify Premium is required for browser playback.

## Requirements

- Docker Engine with Compose plugin for the container route, or Node.js 24 for local development.
- A Spotify Premium account and a Spotify Developer app. The owner's app has been configured; sign-in, a 402-item playlist load, and audible browser playback have been verified. Other live scenarios remain in the [release checklist](docs/qa.md).
- A source playlist you can edit. The optional history playlist must be different and editable.

Spotify's current Development Mode access and limits can change. Check the [Spotify migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and your own Developer Dashboard before setup.

## Spotify Developer Dashboard setup

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Enable the Web API and Web Playback SDK if the dashboard asks for API selection.
2. Add this exact redirect URI for the default local setup: `http://127.0.0.1:3000/auth/callback`. Spotify [requires an exact registered match](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). `localhost` is not an accepted redirect host; use `127.0.0.1` in both dashboard and `.env`.
3. Copy `.env.example` to `.env`. Set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and a long random `SESSION_SECRET`. Keep `.env` private. The server uses the client secret and retains Spotify tokens in its protected data store; the browser receives an app session cookie.
4. Keep `APP_BASE_URL=http://127.0.0.1:3000` and `SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/auth/callback` for the default local port. If you change the host port, change both values and the registered URI to match.

Generate a session secret with `openssl rand -hex 32`. Do not commit `.env`, copy its values into issues, or put credentials in URLs.

## Run with Docker Compose

```sh
cp .env.example .env
# Edit .env first.
docker compose up --build -d
docker compose ps
```

Open `http://127.0.0.1:3000`. The container serves the web build and API from port 3000, while Compose publishes it on host loopback only. The `rotation_data` named volume keeps the Spotify connection, playlist configuration, and small operation log when the container is replaced. `/health` returns process health without account information. Stop with `docker compose down`; avoid `down --volumes` unless you intend to erase the connection and settings.

For later code updates, pull or check out the desired revision and run `docker compose up --build -d` again. Plain `docker compose up` does not automatically rebuild an existing image after source edits. During development, Docker Compose 2.22 or later supports `docker compose up --watch`: the rules in `compose.yaml` rebuild and replace the service when `server/` or `web/` changes. This is a full rebuild for compiled TypeScript, not live code injection. See [Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/) and [`up --build`](https://docs.docker.com/reference/cli/docker/compose/up/). Watch mode runs in the foreground and consumes resources for file monitoring; use normal detached mode for daily use.

The image and Compose service were built and smoke tested on CachyOS on 2026-10-01. The container became healthy, served the web app and API on host loopback, and retained its named volume across a restart and a `docker compose down` / `up` cycle. A live Spotify sign-in from inside the container has not yet been tested.

## Local development

```sh
npm --prefix server ci
npm --prefix web ci
npm --prefix web run build
set -a; . ./.env; set +a
export DATA_DIR="$PWD/.local-data" WEB_DIST_DIR="$PWD/web/dist"
npm --prefix server run dev
# In another terminal:
npm --prefix web run dev
```

The Vite development server proxies `/api` and `/auth` to the backend on port 3000. Spotify's callback returns to port 3000, so build the web files once before signing in; the server can then serve its callback landing page. After login, use `http://127.0.0.1:5173` for hot reload. The shell commands load `.env` for the backend and use a writable local data directory; Compose overrides `DATA_DIR` with `/app/data` inside the container. Register `http://127.0.0.1:3000/auth/callback` in Spotify for this workflow. Run available checks with `npm --prefix server test`, `npm --prefix server run typecheck`, `npm --prefix server run build`, and `npm --prefix web run build`.

## Behavior and limits

The app keeps a stable shuffled order for the current listening session. Next and previous change playback without editing a playlist. With history set to **None**, removal edits only the source. When history is selected, the server adds to history before removing from the source. If the add fails, the source stays untouched. If removal fails after adding, the app records the partial action and retry must remove from source without adding to history again.

Spotify's [current remove endpoint](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) accepts an item URI and playlist snapshot, but no occurrence position. **Remove and skip is blocked when the same URI occurs more than once in the source playlist.** This prevents an ambiguous edit; normal skip still works. The app also blocks stale or changed playlist snapshots for review. If Spotify may have accepted an archive add but did not confirm it, the app reports an uncertain outcome. Check the archive in Spotify before choosing an explicit recovery action; it will not blindly add another copy. See [the API decision record](docs/architecture.md).

Spotify metadata and artwork come from Spotify and should appear only with Spotify playback and links to the relevant Spotify content. No audio is stored by this app. The account's SDK `account_error` indicates when Premium playback is unavailable; configuration can remain usable.

## Data, backup, and disconnect

Stop the app before backing up its named volume. The example below writes a compressed backup under a local `backups/` directory; protect it because the data can include Spotify refresh credentials.

```sh
mkdir -p backups
docker compose stop
docker compose run --rm --no-deps -v "$PWD/backups:/backup" --entrypoint tar rotation -czf /backup/rotation-data.tgz -C /app/data .
docker compose start
```

To restore, stop the app, then extract the archive into a fresh `rotation_data` volume using the same one-off container pattern. Keep the app's `.env` and session secret with the backup; losing the secret may invalidate stored encrypted tokens. Loss of the volume disconnects Spotify and loses saved playlist choices, but it does not delete Spotify playlist content. The app's Disconnect action clears local tokens, session, and saved settings; Spotify may also let you remove the app's access in account settings.

```sh
docker compose stop
docker compose run --rm --no-deps -v "$PWD/backups:/backup:ro" --entrypoint tar rotation -xzf /backup/rotation-data.tgz -C /app/data
docker compose start
```

The server encrypts its JSON store with a key derived from `SESSION_SECRET` and restricts file permissions. The data volume still needs host-level protection, and `SESSION_SECRET` should be backed up separately from public files. Changing the secret prevents decryption of existing data.

## Network and troubleshooting

The default loopback binding is for one browser on the Docker host. For another machine on a private LAN, place the app behind an HTTPS reverse proxy, use a registered HTTPS redirect URI and matching `APP_BASE_URL`, and restrict network access. Do not expose this single-user app directly to the public internet. HTTP OAuth redirects are permitted by Spotify only for literal loopback addresses such as `127.0.0.1`; see [Spotify's redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

| Symptom | Check |
| --- | --- |
| Redirect mismatch | Dashboard URI and `SPOTIFY_REDIRECT_URI` must match exactly; use `127.0.0.1`, not `localhost`. |
| Spotify login refused | Confirm Developer Dashboard access, app owner eligibility, and current Development Mode limits. |
| Browser player unavailable | Confirm Premium, a supported browser, user gesture to start, and the SDK `account_error` or `authentication_error` shown in the app. |
| Playlist cannot be edited | Confirm the Spotify account owns or can edit that playlist and the app was granted playlist modify scope. |
| Slow or rate-limited requests | Wait for Spotify's `Retry-After`; avoid repeated refresh clicks. |
| Settings disappear after restart | Confirm `rotation_data` still exists and `SESSION_SECRET` has not changed. |
| Container unhealthy | Run `docker compose logs rotation` and `docker compose exec rotation node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"`. Do not post logs without checking for sensitive values. |

## Project layout

- `server/`: Fastify API, OAuth, Spotify API client, and protected persistence.
- `web/`: React/Vite player and settings UI.
- `docs/architecture.md`: API scopes, sequence diagrams, and duplicate safety decision.
- `docs/qa.md`: release checks and live Spotify test matrix.
- `Dockerfile`, `compose.yaml`: single-service deployment.
