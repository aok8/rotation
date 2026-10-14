# One-call Mac Spotify Connect check

## In-app check with the rebuilt Player client

The **Playback check** panel beside the device picker sends the same direct request builders used by the isolated helper and Rotation's command client. Select the official Mac output, open the panel, and choose **Play playlist context** once. This sends the source playlist context and the selected song offset, matching Spotifast's playlist-row start. It does not turn modes off or chain a transfer, state poll, or retry. Listen for at least 15 seconds, then choose **Read state** once and record its timestamped summary. A successful send reports acceptance only. If the device remains idle, stop that attempt rather than stacking commands.

For a separate fresh-baseline comparison, **Play Rotation tracks** sends the shuffled URI window. **Resume in Spotify**, **Pause in Spotify**, **Next in Spotify**, and **Previous in Spotify** are direct commands against Spotify's existing queue, not Rotation navigation. Ordinary polling, transport and removal controls are suspended while the panel is open. Direct commands clear the saved queue hint before sending, even on timeout, but do not change Rotation's selected index, order or playlists. Close the panel and use ordinary Play to restore the Rotation queue.

The owner's successful Spotifast test used its default sign-in. Testing Spotifast with the same personal Developer app and its additional callback `http://127.0.0.1:8989/login` checks app identity; it still leaves grant scopes and OAuth implementation different. Do not copy its public/default client identity into Rotation. The [QA notes](qa.md) explain those variables.

## Command-line alternative

This is an opt-in live test for a Mac where the Spotify desktop app appears as a Connect device but a Rotation Play or Next command stalls or stops audio. The owner has reported that behavior; a later Rotation diagnostic showed the selected Mac active with Shuffle and Repeat off, yet no current track item across repeated successful player-state reads. Spotifast started a newly selected track on the same Mac using Spotifast's **default sign-in**, even after Rotation failed. That does not isolate Rotation's different Developer app/grant or its request body. The helper included in a new desktop package sends **one Spotify Player API request per invocation**. It does not edit playlists, transfer automatically, retry, or poll for confirmation. An HTTP success means Spotify accepted the request; listen and inspect Spotify to determine whether playback changed.

## Prepare one run

1. Use a package containing `scripts/spotify-player-isolate.mjs`. Confirm its build identity in Rotation first. Complete Spotify sign-in and choose a source playlist with a harmless test song; `play-one` uses Rotation's saved current song and `play-window` uses its current window of up to 20 songs. If upgrading from an earlier package, choose **Reconnect Spotify** with the same account to grant queue-reading permission for Next; your playlist settings are retained. Use a disposable playlist if you will later test removal in the app.
2. Open Spotify's desktop app on the Mac under the same Premium account. Note whether it is initially idle, paused, or playing; record the macOS and Spotify desktop versions. Check whether Spotify's own web player can control the Mac **before** the test.
3. Use **Quit rotation** and wait until `http://127.0.0.1:3000/health` no longer answers. The diagnostic refuses to run while Rotation serves port 3000, so an app command cannot overlap it. Keep the Spotify desktop app open.
4. In Terminal, set the package location. Adjust this path if `Rotation.app` is elsewhere:

   ```sh
   ROTATION_APP=/Applications/Rotation.app/Contents/Resources/Rotation
   ```

The helper reads the existing local Rotation connection from your user profile. It does not need an access token, Client Secret, or session file on the command line. **Never paste those secrets, a full config file, a session file, or raw Spotify device IDs into an issue or chat.** Keep the helper's output local until you have reviewed it; share only the build ID, command name, sanitized status/error, elapsed time, and what happened in Spotify.

In a package with the payload parity change, `play-one` and `play-window` send their saved URI list with `offset:{position:0}` and no zero `position_ms`, matching Rotation's current Play shape. This isolates the list-start command, not Spotifast's OAuth grant. `play-context` is a separate diagnostic shape that follows the source playlist's order; do not substitute it for Rotation's shuffled queue.

## Choose one call

First list devices with one read-only call. The output shows device IDs for local selection; keep those IDs private.

```sh
"$ROTATION_APP/runtime/node" "$ROTATION_APP/scripts/spotify-player-isolate.mjs" --command devices
```

Copy the Mac desktop device ID locally. To record a separate read-only playback snapshot, run the same helper with `--command state --device-id 'PASTE_LOCAL_MAC_DEVICE_ID_HERE'`. Each invocation is a separate request. For the first mutation, use **only** a single-song Play, with the Spotify desktop app already open:

```sh
"$ROTATION_APP/runtime/node" "$ROTATION_APP/scripts/spotify-player-isolate.mjs" --command play-one --device-id 'PASTE_LOCAL_MAC_DEVICE_ID_HERE'
```

Wait at least 15 seconds without clicking Play again. Record the helper's sanitized `method`, `endpoint`, `status`, `elapsedMs`, `retryAfterSeconds`, and error summary; whether the selected song audibly played; whether Spotify desktop paused or stalled; and whether Spotify's own web player still controls the Mac. If this single call reproduces the problem, **stop the bisect there**. A second call would obscure which action caused it.

If the one-song command works, quit and reopen Spotify's desktop app to restore a clear baseline before trying **one** different command. Replace `play-one` in the command above with one of these names; keep the same explicit `--device-id`. Run `devices` or `state` separately when you need a fresh read. Do not run these as a shell loop or rapid sequence.

| One command per fresh baseline | Question it answers |
| --- | --- |
| `play-window` | Does sending up to 20 saved Rotation URIs behave differently from one URI? |
| `resume` | Does a bodyless resume of the selected device work when its current song is paused? It does not select Rotation's current URI. |
| `play-context` | Does playing the saved current song within its source playlist context behave differently from a URI list? It follows the playlist's order, not Rotation's shuffle; use only for diagnosis. |
| `transfer-paused` | Does a transfer with `play:false`, preserving Spotify's playing/paused state, activate the desktop app? |
| `transfer-play` | Does `play:true` transfer activate the intended desktop app? |
| `shuffle-off` or `repeat-off` | Does one mode change affect the desktop app? Each is a separate call. |
| `next` | Does Spotify's native single-call skip work on the selected device? |

If the helper says the saved access token expired, reopen Rotation, refresh its device list, use **Quit rotation**, then repeat the same one-call test. A timeout or accepted 2xx response still needs an audio and web-player observation. The helper does not confirm playback for you.

| Record for each isolated attempt | Value |
| --- | --- |
| Package build ID; macOS version; Spotify desktop version | Local notes |
| Initial desktop state and whether Spotify web could control it | Idle, paused, or playing; yes/no |
| One helper command and target device type | Command name; Mac desktop device (omit its ID when sharing) |
| Sanitized HTTP result | Method, endpoint, status, elapsed time, Retry-After seconds, error summary |
| Result after 15 seconds | Audible selected song, desktop paused/stalled, Spotify web still controls Mac |

This test distinguishes individual Web API calls from Rotation's full command path. It cannot, by itself, prove why Spotify's desktop client accepted or ignored a request. The app's automated tests use mocked Spotify responses and cannot establish live Mac behavior.
