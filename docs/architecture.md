# Rotation architecture and API decisions

Checked against Spotify's official documentation on 2026-10-01. This is an implementation plan, not an instruction embedded in the product brief. Live Spotify verification still requires a developer app and a Premium account.

## Shape

One Node.js 24 container serves a React/Vite static build and a TypeScript Fastify API. The browser owns Web Playback SDK state. The server owns Spotify OAuth, token refresh, playlist configuration, playlist requests, the authoritative session shuffle order, and the remove/archive operation. Protected JSON state in `DATA_DIR` keeps the connection and playlist choices across restarts. No database or second long-running service is needed. A single service avoids idle CPU cost from extra components. The Web Playback SDK script is loaded from Spotify, not bundled.

The backend must validate the app session and same-origin mutation requests, refresh expired Spotify access tokens, serialize destructive operations, and redact secrets from errors and logs. The browser must treat every Spotify text field as untrusted and render it as text, never raw HTML. The `/health` endpoint returns only process health.

## Spotify API and scope matrix

| Task | Official API | Scope | Notes |
| --- | --- | --- | --- |
| Login | [Authorization Code flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow) | Listed below | Server stores client secret; state protects callback. |
| List playlists | [GET `/me/playlists`](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists) | `playlist-read-private`; `playlist-read-collaborative` if collaborative lists are desired | Page through results, maximum 50 per request. |
| Read playlist items | [GET `/playlists/{id}/items`](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) | `playlist-read-private` for private playlists | Page through `items`, maximum 50 per request. Skip unsupported records safely. |
| Add to archive | [POST `/playlists/{id}/items`](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist) | `playlist-modify-public` or `playlist-modify-private`, as appropriate | Body `{"uris":["spotify:track:..."]}`; returns snapshot. |
| Remove from source | [DELETE `/playlists/{id}/items`](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) | `playlist-modify-public` or `playlist-modify-private`, as appropriate | Body `{"items":[{"uri":"spotify:track:..."}],"snapshot_id":"..."}`. No position selector in current schema. |
| Browser player | [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk/reference) | `streaming` | Premium required; `account_error` is the Premium signal. |
| Start selected track and control device | [Start/resume](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback), [transfer](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback), [seek](https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track) | `user-modify-playback-state` | Use explicit track URI from session order; SDK player events are authoritative for visible playback state. |

The initial scope request is `playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-modify-playback-state streaming`. `user-read-playback-state` is needed only if implementation calls the playback state/device read endpoints. Do not request `user-read-private` to infer Premium: current SDK [account errors](https://developer.spotify.com/documentation/web-playback-sdk/reference) give the applicable result. Scope definitions are in [Spotify's scope reference](https://developer.spotify.com/documentation/web-api/concepts/scopes).

## Duplicate and stale item safety

The brief asks for exact occurrence removal. Spotify's [current remove endpoint](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist) accepts a URI and optional snapshot ID, but its documented request has no occurrence position. The old `/tracks` route is deprecated and must not be used to regain a position selector. A snapshot protects against some stale edits; it does not identify which of two equal URIs the user selected. Therefore **Remove and skip is disabled for a URI that appears more than once in the current source playlist**. Standard next/previous still work. The server refreshes the playlist before the mutation, checks that the selected URI is unique and still present, and blocks on any ambiguity or changed snapshot. It never replaces the whole playlist. This is a deliberate limitation until Spotify offers an exact occurrence operation.

For a unique URI, archive first, then remove. If archive fails, leave the source and playback untouched. If removal fails after archive succeeds, persist a partial operation record so retry only repeats removal. Do not advance until source removal succeeds. Because Spotify offers no cross-playlist transaction, a process failure between the API calls can leave a partial operation requiring recovery. Keep the operation log small and avoid full listening history.

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

Run on loopback by default. Spotify requires an exact registered redirect URI; [HTTP loopback IP literals are allowed, `localhost` is not](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). LAN access requires an HTTPS reverse proxy, registered HTTPS redirect, and network access control. Spotify Development Mode eligibility and quotas can change; check the [migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and dashboard before live use.
