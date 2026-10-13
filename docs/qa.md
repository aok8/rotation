# Release checks

The build and type checks can run without Spotify. Live checks require the owner's Premium account, a configured Developer app, an available Connect device, and an isolated pair of playlists so edits do not affect personal playlists. Earlier 2026-10-01 checks verified sign-in, loading a 402-item playlist, and browser playback in the previous SDK design. The SDK was removed because the user requested playback on a selected Spotify device. The owner has since observed a Mac desktop Connect stall, including a period when Spotify's web player could not control that desktop app. Spotifast later controlled that same Mac successfully using **Spotifast's default sign-in**, not Rotation's personal Developer app; the differing app registration and grant are still unisolated. No HTTP response capture yet identifies Rotation's failing call. The [one-call Mac bisect](mac-connect-bisect.md) records that evidence without sharing tokens or credentials. The matrix rows below are release checks, not claimed results.

## Automated and desktop checks

On 2026-10-13, the mode-normalization, explicit activation, and resume changes passed 12 server integration tests, 16 web tests, and 4 one-call helper tests. A browser fixture verified accepted-but-unconfirmed activation, direct Play remaining available, pending Play, and Pause/Next becoming available after an observed playback match. These tests use mocked Spotify responses. The owner's earlier captured Mac attempt showed one accepted Play (204 in 223 ms) followed by repeated player-state 204 responses for about 42 seconds; it contained no transfer, mode-change, or Next mutation. That is evidence of missing playback confirmation, not a diagnosis of the Spotify client or app registration.

```sh
npm --prefix server ci
npm --prefix web ci
npm --prefix server test
npm --prefix server run typecheck
npm --prefix web run typecheck
npm --prefix server run build
npm --prefix web run build
node --test scripts/spotify-player-isolate.test.mjs
```

Run the launcher and package checks from [desktop release checks](desktop-qa.md). They cover first-run secret generation, per-user paths, loopback binding, the exact Spotify callback, protected Quit, payload inspection, and package startup/shutdown. The staged package smoke test uses fake credentials and no Spotify connection.

Recorded automated evidence on 2026-10-01: server integration tests, desktop runtime tests, web playback-state tests, typecheck, and server/web builds passed. A local launcher smoke run with fake credentials on CachyOS (Arch-derived) confirmed a `127.0.0.1` listening socket, minimal `/health`, and clean unauthenticated Quit. A locally built Linux x64 package passed packaged-runtime smoke inside an official Arch Linux 2026.10.01 bootstrap root filesystem. [Desktop packages workflow run 36953300303](https://github.com/aok8/rotation/actions/runs/36953300303) passed package builds, bundled-runtime smoke tests, and payload checks for Linux x64/arm64, Windows x64, and macOS x64/arm64. These checks did not play Spotify audio. Manual downloaded-package verification on Windows, macOS, and Arch Linux remains pending in [the desktop matrix](desktop-qa.md). The owner's Mac observations are user-reported live evidence, distinct from a recorded, repeatable one-call API test.

## Live Spotify matrix

| Scenario | Expected result |
| --- | --- |
| OAuth success, cancel, altered/expired state | Success creates an HttpOnly app cookie; failures show recovery guidance and do not create a session. |
| Playlist list with more than 50 entries | Pagination returns all accessible entries up to the documented app limit. |
| Source and archive selection | IDs persist across restart; equal IDs are rejected; None is allowed. |
| Empty playlist; unavailable/local/episode entries | Empty state appears and unsupported entries do not crash the session. |
| No devices; restricted or vanished device | Clear picker state and refresh guidance; no silent fallback to another device or browser audio. |
| Explicitly activate an inactive selected device | One `play:false` transfer, followed by bounded observation; an accepted but unconfirmed activation remains recoverable and does not claim a song started. |
| Active target with Shuffle/Repeat on | Rotation changes only the known-on modes, verifies both off, then starts its ordered window. If Spotify does not confirm the changes, it does not send Play. |
| Paused expected URI on the selected device | Bodyless resume continues the same track without replacing the queue or starting an unrelated URI. |
| Spotify opens after Rotation | Returning to the Rotation tab refreshes the device list and enables controls when a controllable device appears. |
| Active device has no Spotify device ID | Rotation explains that Spotify has not supplied a controllable ID and asks the user to reopen Spotify and refresh. It never guesses a target or sends a command to another device. |
| Selected Mac device but Play stays disabled on “Starting…” | A delayed playback-state response must not leave Play disabled indefinitely. After the confirmation window, show a recovery message and allow another attempt. Record whether audio started on the Mac. |
| Premium device playback, pause/seek/previous/next | Commands target the selected Connect device; state follows Spotify's playback API; normal navigation never edits playlists. |
| Return after Spotify advances one or several queued tracks while tab is hidden | Rotation catches up to the current track in the submitted queue without replaying it or editing playlists. Verify paused and playing states. |
| Repeated URI in the queued window | Rotation avoids guessing which copy is playing and presents a recoverable mismatch. |
| External device or track switch | Controls show the mismatch and do not claim Rotation is still playing its selected track. |
| End of track and end of rotation | Advance through the stable order once; paused near the end never auto-advances; the last item stops cleanly. |
| Queue-window boundary | Manual Next restores the next ordered window. There is no server refill watcher; after a long hidden period, Play/Next may be needed on return. Check for an audible jump and avoid repeated refresh calls. |
| Playback scope, authentication, or Premium error | Reauthorization or clear recovery guidance; playlist settings stay reachable when possible. |
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
