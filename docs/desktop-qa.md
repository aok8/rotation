# Desktop release checks

This checklist is for the portable desktop launcher and any later installer. It does not claim that a platform has been tested until its row is recorded as passing. The Docker service and desktop launcher share the web/API code, but their network exposure and data locations differ.

## Packaging contract

- The desktop process binds its HTTP listener to the literal loopback address `127.0.0.1`. Inspect the actual listening socket after launch; opening a loopback URL in the browser does not prove the process is loopback-only. Docker may continue to bind `0.0.0.0` **inside** its container because Compose publishes only on host loopback by default.
- The browser URL, `APP_BASE_URL`, and `SPOTIFY_REDIRECT_URI` use the same host and port. Register the exact `/auth/callback` URI in Spotify. Spotify [permits HTTP for IP loopback literals and rejects `localhost`](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). If the configured port is busy, fail with a clear recovery message or use a port that the Spotify dashboard registration explicitly permits; never silently choose a callback URI the user did not register.
- First-run configuration, session secret, encrypted token store, and operation log live in a per-user writable data directory outside the application bundle. The launcher creates its own random session secret. A distributed archive or installer must contain no `.env`, client secret, access token, refresh token, `session.enc`, or test fixture with real account data. A bundle update must preserve the per-user data directory.
- There is one clear Quit action usable before Spotify login as well as after login. It stops the local server and releases its port. A desktop-only quit route must be disabled for Docker/LAN mode and protected against cross-site requests; it must not rely solely on a Spotify session because the user may need to quit during setup.
- The package includes production server code, web assets, and only required runtime dependencies. Node.js runtime availability must be explicit: either bundle a compatible Node runtime per platform or state Node 24+ as a prerequisite. A portable Node launcher is not a native installer by itself.

## Automated smoke checks (no Spotify credentials)

Run server and web tests, typechecks, and builds on the supported platforms. Add launcher tests for configuration path selection, first-run secret generation, callback URL derivation, loopback binding, port collision, and graceful quit. Tests should use temporary user data directories and fake client ID/secret values; they must never contact Spotify or open the real browser.

For each staged release payload, run `node scripts/check-desktop-payload.mjs PATH_TO_STAGED_ROTATION` before archiving. It fails on `.env*`, `session.enc`, `config.json`, logs, or top-level data/backup directories. Check the launch command against the actual packaged layout, including relative paths with spaces. Run `node scripts/smoke-desktop.mjs PATH_TO_STAGED_ROTATION` with Node 24 before archiving: it launches the **bundled Node runtime** with fake credentials and a temporary profile, checks the minimal health response and private API, then sends Quit and verifies the process releases its port. Pass `Rotation.app` as the staging path on macOS. Run `node --test scripts/check-desktop-payload.test.mjs` for the scanner itself. The smoke test needs the built server, web assets, and production `server/node_modules` in the staging directory.

## Manual installer and runtime matrix

| Check | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Fresh unpack/install and double-click launch opens setup page | Pending | Pending | Pending |
| First run writes config and random secret under current user profile | Pending | Pending | Pending |
| Listener is only on `127.0.0.1` and callback host/port match browser URL | Pending | Pending | Pending |
| Second launch while first is active has clear behavior; no second unsafe listener | Pending | Pending | Pending |
| Quit before login, after login, and after playback releases the port | Pending | Pending | Pending |
| Reopen retains authorized connection and playlist settings | Pending | Pending | Pending |
| Upgrade retains data but replaces executable assets | Pending | Pending | Pending |
| Uninstall/remove bundle leaves or removes user data as documented | Pending | Pending | Pending |
| Artifact inspection finds no credentials, `.env`, or token store | Pending | Pending | Pending |

Use a disposable Spotify Developer app and playlists for destructive live checks. Verify browser playback separately: a successful playback command alone does not prove audio, button state, or progress are synchronized. Test pause, resume, end of track, last-item removal, device disconnect, and closing the browser while the launcher remains open.

## Platform limits to state in release notes

The Spotify Web Playback SDK runs in a supported browser and requires Premium. A plain Node launcher opens the browser; it does not provide a native media window, system tray, or OS-level playback controls. Some platforms may warn before running an unsigned downloaded executable; never tell users to bypass a security warning. Code signing, notarization, and installer formats are separate release work. The first public build should label exactly which OS and CPU architectures were built and manually smoke tested.
