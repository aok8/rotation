# Rotation architecture and API decisions

Spotify API references were checked on 2026-10-01. The owner's Developer app and Premium account were used for live sign-in, playlist loading, and audible playback in an earlier browser-player build. The current device-based path has automated tests with mocked Spotify responses. The owner has reported a Mac desktop Connect stall, but its failing HTTP call and response are not yet known; [one-call Mac checks](mac-connect-bisect.md) separate that live evidence from the mocks.

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
| Start selected track and control device | [Transfer](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback), [start/resume](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback), [skip next](https://developer.spotify.com/documentation/web-api/reference/skip-users-playback-to-next-track), [pause](https://developer.spotify.com/documentation/web-api/reference/pause-a-users-playback), [seek](https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track) | `user-modify-playback-state` | Premium required. Target the selected device ID for playback. The API response is acceptance, so confirm the resulting device and URI through playback state. |

The scope request is `playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-playback-state user-modify-playback-state`. Rotation removed its browser Web Playback SDK path because the user requested playback on a selected Spotify device; the SDK's `streaming` scope is unnecessary for that design. The packaged Mac app uses the same Spotify Web API as Windows and Linux. It has no AppleScript playback path or macOS Automation permission. Existing connections need Spotify reauthorization to grant the playback-state scope. Scope definitions are in [Spotify's scope reference](https://developer.spotify.com/documentation/web-api/concepts/scopes).

Play first reads current playback once. When the selected device is active and Spotify confirms Shuffle off and Repeat off, it sends a bounded window of up to 20 URIs in Rotation's saved order. If the selected device is inactive or its mode is unknown, Rotation validates it with one device-list read and sends only the current URI as a provisional window. A known Shuffle or Repeat setting that could disturb the order produces a `playback_mode` message asking the user to change that mode in Spotify; Rotation does not chain mode mutations into Play. A successful Play response records the submitted window, while the visible page separately checks the selected device and URI before claiming playback. Spotify's explicit `NO_ACTIVE_DEVICE` 404 is the only transfer fallback: Rotation sends one `play:true` transfer, checks the selected device once, then retries the same Play. It does not transfer based solely on a possibly stale device-list `is_active` flag.

Within a verified multi-item window, Next makes one playback mutation: Spotify's native skip. It first reads current playback and Spotify's next queued URI, then confirms the expected device and track before committing Rotation's index. A queue mismatch blocks the skip. These reads count toward the same 10-second deadline; one mutation is not one total HTTP request. For an ambiguous duplicate URI, manual Next explicitly reseeds the selected occurrence instead of issuing native skip. Previous and window-boundary Next also reseed from the selected index. A provisional one-song window can grow to a full window on the next deliberate Play or Next once Spotify reports safe modes. Returning to a visible page reconciles a uniquely matching URI within the submitted window without replaying it; repeated URIs remain ambiguous for automatic catch-up. There is no server watcher for the queue boundary: if the browser stays hidden beyond the 20-song window, continuing Rotation may require Next or Play after returning. An unrelated Spotify track is reported for review before another command.

Player commands have a 10-second application deadline and a short cooldown after a timeout, server error, or rate limit. The authenticated diagnostic log records endpoint, method, status, elapsed time, a request correlation ID, and a sanitized error code without tokens, device IDs, track URIs, or Spotify response bodies. This gives a trace of the actual API behavior while keeping private Spotify data out of the copied report. A 2xx response does not prove that the device played audio; [the one-call Mac bisect](mac-connect-bisect.md) is the live check for that gap.

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
                Browser->>Server: Request Play of next selected item
                Server->>Spotify: Start next shuffled URI
            end
        end
    end
```

## Operational boundaries

The desktop launcher binds only to `127.0.0.1` and uses `http://127.0.0.1:3000/auth/callback` by default. Spotify requires an exact registered redirect URI; [HTTP loopback IP literals are allowed, `localhost` is not](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). Choosing another port requires registering its exact callback URI. Desktop packages must omit all credentials and session data. Windows, macOS, and **Arch Linux** are the intended desktop targets; a generic Linux CI runner does not replace an Arch Linux launch test. Spotify Development Mode eligibility and quotas can change; check the [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and dashboard before live use.
