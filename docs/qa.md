# Release checks

The build and type checks can run without Spotify. Live checks require the owner's Premium account, a configured Developer app, and an isolated pair of playlists so edits do not affect personal playlists. Live checks on 2026-10-01 verified Spotify sign-in, loading a 402-item playlist, audible browser playback, advancing progress, and pause/resume controls. The remaining matrix rows are release checks, not claimed results. Changes made outside this app may not immediately appear in its player controls.

## Automated and desktop checks

```sh
npm --prefix server ci
npm --prefix web ci
npm --prefix server test
npm --prefix server run typecheck
npm --prefix web run typecheck
npm --prefix server run build
npm --prefix web run build
```

Run the launcher and package checks from [desktop release checks](desktop-qa.md). They cover first-run secret generation, per-user paths, loopback binding, the exact Spotify callback, protected Quit, payload inspection, and package startup/shutdown. The staged package smoke test uses fake credentials and no Spotify connection.

Current evidence on 2026-10-01: server integration tests, desktop runtime tests, typecheck, and server/web builds passed. A local launcher smoke run with fake credentials on CachyOS (Arch-derived) confirmed a `127.0.0.1` listening socket, minimal `/health`, and clean unauthenticated Quit. [Desktop packages workflow run 36948772439](https://github.com/aok8/rotation/actions/runs/36948772439) passed package builds, bundled-runtime smoke tests, and payload checks for Linux x64/arm64, Windows x64, and macOS x64/arm64. A locally built Linux x64 package passed the packaged runtime smoke script inside an official Arch Linux 2026.10.01 bootstrap root filesystem. Manual downloaded-package installation, browser launch, and live Spotify checks on Windows, macOS, and Arch Linux remain pending in [the desktop matrix](desktop-qa.md).

## Live Spotify matrix

| Scenario | Expected result |
| --- | --- |
| OAuth success, cancel, altered/expired state | Success creates an HttpOnly app cookie; failures show recovery guidance and do not create a session. |
| Playlist list with more than 50 entries | Pagination returns all accessible entries up to the documented app limit. |
| Source and archive selection | IDs persist across restart; equal IDs are rejected; None is allowed. |
| Empty playlist; unavailable/local/episode entries | Empty state appears and unsupported entries do not crash the session. |
| Premium player, user gesture, pause/seek/previous/next | State follows SDK events; normal navigation never edits playlists. |
| SDK account or authentication error | Clear message; settings remain reachable when authorization permits. |
| One unique source URI, history None | Exactly that source URI is removed; player advances only after API success. |
| One unique source URI, history selected | Archive receives one item before source removal; success advances. |
| Duplicate URI in source | Remove action is blocked before archive or source mutation; normal skip works. Test an unplayable duplicate too. |
| Source changed after shuffle started | Remove is blocked and asks to reload rather than editing a stale item. |
| Archive add denied | Source and playback remain unchanged; retry or remove-without-archive is explicit. |
| Source removal denied after archive add | UI reports partial success; retry removes source without a second archive add. |
| Archive request times out after Spotify may have accepted it | UI must treat the outcome as uncertain and avoid blindly re-adding the URI. |
| Spotify 429 | Retry waits for `Retry-After`; UI avoids rapid retries. |
| Disconnect | Cookie and stored connection/config are cleared; protected API routes return 401. |
| Theme and narrow view | Light/dark/system preference, focus states, keyboard control, reduced motion, and mobile layout remain usable. |

Run playlist mutation checks on disposable playlists with known tracks. Afterward, compare Spotify's source and archive contents directly, including duplicate counts. Never use a primary personal playlist for a destructive QA run.
