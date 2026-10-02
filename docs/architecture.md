# Rotation architecture and API decisions

Checked against Spotify's official documentation on 2026-10-01. The owner's configured Developer app and Premium account have been used for a live sign-in, playlist load, and audible playback check.

## Shape

The supported user runtime is a local desktop package with a bundled Node.js 24 runtime. Its launcher starts one Fastify process on `127.0.0.1` and opens the app in the system browser; the React/Vite build and API come from that process. Spotify plays audio on the user's chosen Connect device. The server owns Spotify OAuth, token refresh, device and playback requests, playlist configuration, the authoritative session shuffle order, and the remove/archive operation. Protected JSON state in the per-user `DATA_DIR` keeps the connection and playlist choices across launches. No database or always-on service is needed. The browser is a control surface and does not play audio.

The launcher collects the Spotify Client ID and Client Secret in a loopback-only first-run page, generates `SESSION_SECRET` locally, and stores configuration outside the bundle in the user profile. It sets `HOST=127.0.0.1`, an exact loopback callback URL, and an ephemeral desktop control token when starting the server. The backend validates the app session and same-origin mutation requests, refreshes expired Spotify access tokens, serializes destructive operations, and redacts secrets from errors and logs. The browser treats Spotify text as untrusted data. `/health` returns only process health. The desktop-only Quit API requires same-origin CSRF protection even before Spotify login and signals the launcher to stop the server; closing the browser tab alone does not stop it.

## Spotify API and scope matrix

| Task | Official API | Scope | Notes |
| --- | --- | --- | --- |
| Login | [Authorization Code flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow) | Listed below | Server stores client secret; state protects callback. |
| List playlists | [GET `/me/playlists`](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists) | `playlist-read-private`; `playlist-read-collaborative` if collaborative lists are desired | Page through results, maximum 50 per request. |
| Read playlist items | [GET `/playlists/{id}/items`](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) | `playlist-read-private` for private playlists | Page through `items`, maximum 50 per request. Skip unsupported records safely. |
| Add to archive | [POST `/playlists/{id}/items`](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist) | `playlist-modify-public` or `playlist-modify-private`, as appropriate | Body `{"uris":["spotify:track:..."]}`; returns snapshot. |
| Remove from source | [DELETE `/playlists/{id}/items`](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) | `playlist-modify-public` or `playlist-modify-private`, as appropriate | Body `{"items":[{"uri":"spotify:track:..."}],"snapshot_id":"..."}`. No position selector in current schema. |
| List and inspect Connect devices | [Get available devices](https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices), [get playback state](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback) | `user-read-playback-state` | IDs can change, some devices are absent, and restricted devices reject remote commands. Playback state can be empty. |
| Start selected track and control device | [Start/resume](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback), [pause](https://developer.spotify.com/documentation/web-api/reference/pause-a-users-playback), [seek](https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track) | `user-modify-playback-state` | Premium required. Target the selected device explicitly; reconcile visible state with Spotify rather than treating a successful command as proof of audio. |

The scope request is `playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-playback-state user-modify-playback-state`. The Web Playback SDK `streaming` scope is unnecessary because Rotation does not create a browser playback device. Existing connections need Spotify reauthorization to grant the new playback-state scope. Scope definitions are in [Spotify's scope reference](https://developer.spotify.com/documentation/web-api/concepts/scopes).

The play command sends a bounded window of 20 URIs in the saved shuffle order to the chosen device. The page checks Spotify's playback state at a modest interval while visible, confirms the selected device and URI before showing playback, and replenishes the window near its end. Spotify does not provide an atomic replacement for the remaining queue: replenishment starts the current URI again at its observed position and may briefly jump. If Spotify continues to a track outside Rotation, the page reports the mismatch and waits for the user to choose Play rather than controlling unrelated audio.

## Duplicate and stale item safety

The brief asks for exact occurrence removal. Spotify's [current remove endpoint](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) accepts a URI and optional snapshot ID, but its documented request has no occurrence position. The old `/tracks` route is deprecated and must not be used to regain a position selector. A snapshot protects against some stale edits; it does not identify which of two equal URIs the user selected. Therefore **Remove and skip is disabled for a URI that appears more than once in the current source playlist**. Standard next/previous still work. The server refreshes the playlist before the mutation, checks that the selected URI is unique and still present, and blocks on any ambiguity or changed snapshot. It never replaces the whole playlist. This is a deliberate limitation until Spotify offers an exact occurrence operation.

A concurrent edit between the final read and Spotify's deletion can still create a duplicate. The API does not document an atomic condition for uniqueness, so avoid editing the source playlist elsewhere while using Remove and skip. This residual race cannot be eliminated by the app alone.

For a unique URI, archive first, then remove. If archive fails, leave the source and playback untouched. If removal fails after archive succeeds, persist a partial operation record so retry only repeats removal. If the archive request outcome is unknown because of a timeout or connection loss, hold an `archive_uncertain` operation and require the user to check the archive in Spotify or explicitly remove without archiving. Do not blindly repeat the add. Do not advance until source removal succeeds. Because Spotify offers no cross-playlist transaction, a process failure between the API calls can leave a partial operation requiring recovery. Keep the operation log small and avoid full listening history.

## OAuth sequence

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Server
    participant Spotify
    User->>Browser: Continue with Spotify
    Browser->>Server: GET /auth/start
    Server->>Server: Generate state; store short-lived verifier
    Server-->>Browser: Redirect to Spotify authorize
    Browser->>Spotify: Authorization request and scopes
    Spotify-->>Browser: Redirect with code and state
    Browser->>Server: GET /auth/callback?code&state
    Server->>Server: Verify state and redirect URI
    Server->>Spotify: Exchange code for tokens
    Spotify-->>Server: Access and refresh tokens
    Server->>Server: Persist protected token state; issue app session
    Server-->>Browser: HttpOnly SameSite=Lax cookie; redirect to app
```

## Remove and archive sequence

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Server
    participant Spotify
    User->>Browser: Confirm Remove and skip
    Browser->>Server: Authenticated mutation for selected item
    Server->>Spotify: Refresh source playlist and snapshot
    Spotify-->>Server: Current items and snapshot
    alt URI duplicated or stale
        Server-->>Browser: Block; explain and refresh
    else Unique current URI
        opt Archive chosen
            Server->>Spotify: POST archive item URI
            Spotify-->>Server: Archive snapshot or error
        end
        alt Archive failed
            Server-->>Browser: Keep source and playback; retry option
        else Archive result uncertain
            Server->>Server: Hold uncertain operation
            Server-->>Browser: Check Spotify history; choose recovery explicitly
        else Archive succeeded or None
            Server->>Spotify: DELETE source item URI with snapshot
            alt Remove failed
                Server->>Server: Record partial operation if archived
                Server-->>Browser: Keep current item; retry removal only
            else Remove succeeded
                Server-->>Browser: Success and next session item
                Browser->>Spotify: Start next shuffled URI
            end
        end
    end
```

## Operational boundaries

The desktop launcher binds only to `127.0.0.1` and uses `http://127.0.0.1:3000/auth/callback` by default. Spotify requires an exact registered redirect URI; [HTTP loopback IP literals are allowed, `localhost` is not](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). Choosing another port requires registering its exact callback URI. Desktop packages must omit all credentials and session data. Windows, macOS, and **Arch Linux** are the intended desktop targets; a generic Linux CI runner does not replace an Arch Linux launch test. Spotify Development Mode eligibility and quotas can change; check the [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and dashboard before live use.
