# One-call Mac Spotify Connect check

This is an opt-in live test for a Mac where the Spotify desktop app appears as a Connect device but a Rotation Play or Next command stalls or stops audio. The owner has reported that behavior; no captured Player API response has yet identified the failing call. The helper included in a new desktop package sends **one Spotify Player API request per invocation**. It does not edit playlists, transfer automatically, retry, or poll for confirmation. An HTTP success means Spotify accepted the request; listen and inspect Spotify to determine whether playback changed.

## Prepare one run

1. Use a package containing `scripts/spotify-player-isolate.mjs`. Confirm its build identity in Rotation first. Complete Spotify sign-in and choose a source playlist with a harmless test song; `play-one` uses Rotation's saved current song and `play-window` uses its current window of up to 20 songs. If upgrading from an earlier package, choose **Reconnect Spotify** with the same account to grant queue-reading permission for Next; your playlist settings are retained. Use a disposable playlist if you will later test removal in the app.
2. Open Spotify's desktop app on the Mac under the same Premium account. Note whether it is initially idle, paused, or playing; record the macOS and Spotify desktop versions. Check whether Spotify's own web player can control the Mac **before** the test.
3. Use **Quit rotation** and wait until `http://127.0.0.1:3000/health` no longer answers. The diagnostic refuses to run while Rotation serves port 3000, so an app command cannot overlap it. Keep the Spotify desktop app open.
4. In Terminal, set the package location. Adjust this path if `Rotation.app` is elsewhere:

   ```sh
   ROTATION_APP=/Applications/Rotation.app/Contents/Resources/Rotation
   ```

The helper reads the existing local Rotation connection from your user profile. It does not need an access token, Client Secret, or session file on the command line. **Never paste those secrets, a full config file, a session file, or raw Spotify device IDs into an issue or chat.** Keep the helper's output local until you have reviewed it; share only the build ID, command name, sanitized status/error, elapsed time, and what happened in Spotify.

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
| `transfer-paused` | Does `play:false` transfer pause or wedge the desktop app? |
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
