# rotation

Rotation is a local Spotify playlist curator and remote control. It shuffles a source playlist and lets you clear tracks as you listen on a Spotify device you choose. Optionally choose a history playlist: **Remove and skip** adds the current track to history before removing it from the source. Spotify Premium is required for playback control.

## Get the desktop app

Rotation runs on your computer while you use it. The launcher starts a small server bound to `127.0.0.1:3000` and opens your default browser. Use **Quit rotation** in the app when finished. There is no background service to install.

1. Download the artifact for your operating system and CPU from a successful [Desktop packages workflow run](https://github.com/aok8/rotation/actions/workflows/desktop-packages.yml). Extract the GitHub artifact ZIP, then extract the package inside it.
2. Register `http://127.0.0.1:3000/auth/callback` as an exact redirect URI in your [Spotify Developer app](https://developer.spotify.com/dashboard). Spotify requires the URI to match exactly.
3. Launch Rotation and enter your Spotify Client ID and Client Secret on its first-run setup page. Keep these credentials private. The app saves them in your user profile, outside the package.

See [desktop installation instructions](desktop/INSTALL.md) for Windows, macOS, and **Arch Linux**. Arch Linux is the required Linux target. Other Linux distributions may work with the portable package but are not part of the supported install target. The packages include Node.js; users do not need to install it. GitHub Actions artifacts are test builds, not signed releases.

If you connected an older browser-player version, choose **Reconnect Spotify** once after updating. Rotation now needs permission to read your available playback devices and current playback state. Reconnecting the same Spotify account keeps the saved playlist choices.

A Spotify Premium account, a Developer app, an available Spotify Connect device, and a source playlist you can edit are required. Open Spotify on a computer, phone, or speaker, then choose that device in Rotation. The optional history playlist must be different from the source and editable. Spotify Development Mode access and limits can change; check the [Spotify migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and your Dashboard.

## How it works

The app keeps a stable shuffled order for the listening session. Next and previous change playback without editing a playlist. With history set to **None**, removal edits only the source. When history is selected, the server adds to history before removing from the source. If the add fails, the source stays untouched. If removal fails after adding, the app records the partial action so a retry does not add to history twice.

Spotify's [remove endpoint](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) accepts an item URI and playlist snapshot, but no occurrence position. **Remove and skip is blocked when the same URI occurs more than once in the source playlist.** Normal skip still works. The app also blocks stale or changed playlist snapshots for review. If Spotify may have accepted an archive add without confirming it, the app asks you to check the archive in Spotify before choosing a recovery action. See the [API decision record](docs/architecture.md).

Spotify provides the metadata and artwork shown in Rotation and plays audio in the selected Spotify app or Connect device. Rotation does not play or store audio. If playback control is unavailable, playlist configuration remains usable.

## Data, updates, and troubleshooting

Replacing the extracted app folder updates the program without deleting your saved connection and playlist settings. On Arch Linux, configuration is under `~/.config/rotation` and data is under `~/.local/share/rotation` by default (XDG overrides are respected). Windows uses `%APPDATA%\Rotation` and `%LOCALAPPDATA%\Rotation\data`; macOS uses `~/Library/Application Support/Rotation`. Back up the config and data directories together while Rotation is stopped. They contain Spotify credentials or encrypted tokens; losing the config's session secret makes existing encrypted data unreadable. **Disconnect Spotify** clears the local connection and settings. Deleting the app folder alone leaves profile data in place.

| Symptom | Check |
| --- | --- |
| Redirect mismatch | Dashboard URI must be exactly `http://127.0.0.1:3000/auth/callback` for the default port. Use `127.0.0.1`, not `localhost`. |
| Setup says “Refresh setup and try again” after saving credentials | Update to a package built after the Windows setup form fix, then reopen setup and submit again. Older packages could send a browser form request with `Origin: null`. |
| Spotify login refused | Confirm Developer Dashboard access, app owner eligibility, and current Development Mode limits. |
| No Spotify device appears or Play/Next are grey | Open Spotify on the intended device, make sure it is online and signed into the same Premium account, start playback there, then return to Rotation or refresh the device list. Check the picker message for a restricted device. Some device models may not appear through Spotify's API. |
| Device will not play | Confirm Premium and choose a device that is available and unrestricted. If Rotation says the device did not activate, open Spotify on that device, refresh the list, and retry Play. Reconnect Spotify if Rotation reports missing playback permission. If Spotify accepts Play but the selected device stays silent, open `/api/playback/diagnostic` on the same local address in your signed-in browser and share its privacy-safe result when reporting the issue. |
| Mac app does not open a browser tab | Open `http://127.0.0.1:3000` manually. It should show Rotation or the first-run setup page. If the connection is refused, run the app's `Contents/MacOS/Rotation` executable from Terminal and note any error without sharing Spotify credentials. |
| Playlist cannot be edited | Confirm the account can edit it and granted the playlist modify scope. |
| Port 3000 is in use | Reopen the existing Rotation tab or quit the other process using that port. |
| Settings disappear after restart | Check the user profile data directories and whether the config's session secret changed. |
| Slow or rate-limited requests | Wait for Spotify's `Retry-After`; avoid repeated refresh clicks. |

## Develop from source

Node.js 24 and npm are required for development. The desktop package includes its own Node runtime. The source launcher uses the same first-run setup page as the package. If you run the server directly without the launcher, copy `.env.example` to `.env` and fill in Spotify credentials. Never commit `.env`.

```sh
npm --prefix server ci
npm --prefix web ci
npm --prefix server run build
npm --prefix web run build
node desktop/launcher.mjs
```

The launcher serves the built web app on port 3000. For web hot reload, run `npm --prefix web run dev` in another terminal and open `http://127.0.0.1:5173`; its API and auth requests proxy to port 3000. Run checks with `npm --prefix server test`, `npm --prefix server run typecheck`, `npm --prefix server run build`, `npm --prefix web run build`, and `node --test desktop/test/*.test.mjs`.

The [architecture](docs/architecture.md), [desktop release checks](docs/desktop-qa.md), and [Spotify QA checklist](docs/qa.md) document implementation decisions and remaining live checks.
