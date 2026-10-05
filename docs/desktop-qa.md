# Desktop release checks

This checklist is for the supported local desktop package. The required Linux user target is **Arch Linux**. A generic Linux CI build or a smoke run on an Arch-derived distribution does not count as a manual Arch Linux pass. No platform is marked manually tested until the corresponding packaged artifact has been installed and checked there.

## Packaging contract

- The desktop process binds its HTTP listener to the literal loopback address `127.0.0.1`. Inspect the actual listening socket after launch; opening a loopback URL in the browser does not prove the process is loopback-only. The launcher sets `HOST=127.0.0.1`; verify the actual socket rather than relying on the browser URL.
- The browser URL, `APP_BASE_URL`, and `SPOTIFY_REDIRECT_URI` use the same host and port. Register the exact `/auth/callback` URI in Spotify. Spotify [permits HTTP for IP loopback literals and rejects `localhost`](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). If the configured port is busy, fail with a clear recovery message or use a port that the Spotify dashboard registration explicitly permits; never silently choose a callback URI the user did not register.
- First-run configuration and session secret live in a per-user config directory; the encrypted token store and operation log live in a per-user data directory. Both are outside the application bundle. The launcher creates its own random session secret. A distributed archive or installer must contain no `.env`, client secret, access token, refresh token, `session.enc`, or test fixture with real account data. A bundle update must preserve the per-user data directory.
- There is one clear Quit action usable before Spotify login as well as after login. It stops the local server and releases its port. The desktop-only quit route must be absent in non-desktop mode and protected against cross-site requests; it must not rely solely on a Spotify session because the user may need to quit during setup.
- The package includes production server code, web assets, and only required runtime dependencies. Node.js runtime availability must be explicit: either bundle a compatible Node runtime per platform or state Node 24+ as a prerequisite. A portable Node launcher is not a native installer by itself.

## Automated smoke checks (no Spotify credentials)

Run server and web tests, typechecks, and builds on the supported platforms. Launcher tests cover configuration path selection, first-run secret generation, callback URL derivation, loopback binding, port collision, and graceful quit. Tests use temporary user data directories and fake client ID/secret values; they must never contact Spotify or open the real browser.

For each staged release payload on its native operating system, run `node scripts/check-desktop-payload.mjs PATH_TO_STAGED_ROTATION` before archiving. It fails on `.env*`, `session.enc`, `config.json`, logs, or top-level data/backup directories. Check the launch command against the actual packaged layout, including relative paths with spaces. Run `node scripts/smoke-desktop.mjs PATH_TO_STAGED_ROTATION` with Node 24 before archiving: it launches the **bundled Node runtime** with fake credentials and a temporary profile, checks the minimal health response and private API, then sends Quit and verifies the process releases its port. Pass `Rotation.app` as the staging path on macOS. Also open the macOS `.app` through Launch Services and check that it starts without an unresponsive-app warning; invoking `Contents/MacOS/Rotation` directly does not test Finder launch behavior. Run `node --test scripts/check-desktop-payload.test.mjs` for the scanner itself. The smoke test needs the built server, web assets, and production `server/node_modules` in the staging directory.

## Manual package and runtime matrix

| Check | Windows | macOS | Arch Linux |
| --- | --- | --- | --- |
| Fresh extraction and launch opens setup page | Pending | Pending | Pending |
| First run writes config and random secret under current user profile | Pending | Pending | Pending |
| Listener is only on `127.0.0.1` and callback host/port match browser URL | Pending | Pending | Pending |
| Second launch while first is active has clear behavior; no second unsafe listener | Pending | Pending | Pending |
| Quit before login, after login, and after playback releases the port | Pending | Pending | Pending |
| Reopen retains authorized connection and playlist settings | Pending | Pending | Pending |
| Upgrade retains data but replaces executable assets | Pending | Pending | Pending |
| Uninstall/remove bundle leaves or removes user data as documented | Pending | Pending | Pending |
| Artifact inspection finds no credentials, `.env`, or token store | Pending | Pending | Pending |

Use a disposable Spotify Developer app and playlists for destructive live checks. Verify audio on the selected Spotify device: a successful playback command alone does not prove audio, button state, or progress are synchronized. Test device selection and refresh, pause, resume, seek, end of track, last-item removal, device disconnect, and closing the browser while the launcher remains open.

On macOS, launch `Rotation.app` from Finder and verify a browser tab opens without Finder marking the app unresponsive. Open Spotify's desktop app under the same Premium account and start a track, then launch Rotation. Confirm the Mac appears in Rotation's device picker and that Play, Next, pause, and seek affect the Spotify app. Repeat with Spotify started *after* Rotation, then switch away from the Rotation browser tab and let at least two queued tracks finish. Returning to the tab should bring Rotation to Spotify's current track without restarting audio. If controls are disabled, record whether the Mac device is absent, restricted, has no Spotify device ID, or is selected while a command is waiting. In particular, check that “Starting on…” either becomes Playing or releases the Play button with an actionable message after the confirmation window.

## Verification recorded so far

On 2026-10-01, the server's desktop Quit API test and launcher unit tests passed. A local fake-credential launcher smoke test passed on CachyOS (Arch-derived), and a locally built Linux x64 archive passed the packaged-runtime smoke script inside the official Arch Linux 2026.10.01 bootstrap root filesystem. This checks startup, health, API protection, Quit, and port release on Arch Linux x64; it does not check the desktop shortcut, browser launch, or Spotify audio. [Desktop packages workflow run 36953300303](https://github.com/aok8/rotation/actions/runs/36953300303) passed the current Connect-based app's five-platform package matrix (Linux x64/arm64, Windows x64, macOS x64/arm64), including bundled-runtime smoke and payload inspection on each native runner. Server integration tests and web playback-state tests passed. Manual launch of a downloaded Connect-based artifact and live Spotify-device playback remain pending on Windows, macOS, and **Arch Linux**. Arch Linux arm64 has CI package smoke but no Arch Linux runtime check. Record each artifact's OS, CPU architecture, build run, and manual result before calling it manually verified.

## Platform limits to state in release notes

Spotify plays audio on the selected Spotify app or Connect device; Rotation's browser page only shows controls and playlist actions. Playback control requires Premium. The launcher does not provide a native media window, system tray, or OS-level playback controls. Some platforms may warn before running an unsigned downloaded executable; never tell users to bypass a security warning. Code signing, notarization, and installer formats are separate release work. The first public build should label exactly which OS and CPU architectures were built and manually smoke tested.
