# Local desktop launcher

Run the built app with Node.js 24 or newer:

```sh
npm --prefix server ci
npm --prefix web ci
npm --prefix server run build
npm --prefix web run build
node desktop/launcher.mjs
```

The first launch opens a setup page on `http://127.0.0.1:3000`. Enter your Spotify Developer app's Client ID and Client Secret there. Register **exactly** `http://127.0.0.1:3000/auth/callback` in Spotify's dashboard first. The setup page generates a random session secret locally. The launcher then starts the existing server on loopback and opens the default system browser. Spotify playback stays in that browser.

The launcher stores credentials in a per-user `config.json` and the encrypted Spotify session in a separate per-user data directory. Neither file belongs in a distributable package. On Linux the defaults are `~/.config/rotation` and `~/.local/share/rotation`; XDG variables are respected. On macOS both live below `~/Library/Application Support/Rotation`. On Windows configuration uses `%APPDATA%\Rotation` and data uses `%LOCALAPPDATA%\Rotation\data`. POSIX directories and the config file are restricted to the user. Protect the Windows user profile with normal account permissions. Back up the config and data together: losing the session secret makes the encrypted data unreadable.

Use **Quit rotation** in the app or setup page to stop the local server. Closing a browser tab leaves the launcher running; reopening the launcher opens the existing instance. Ctrl+C or a normal process termination also stops the server gracefully. If port 3000 is occupied by another application, close it or choose a different port and register the matching callback URI in Spotify.

The package layout is `desktop/launcher.mjs`, `desktop/runtime.mjs`, `server/dist/index.js`, `server/node_modules/` (production dependencies), and `web/dist/`. Packaging may include a private Node runtime and set `ROTATION_NODE_BIN` to its executable. It must exclude `.env`, `config.json`, session data, and real credentials.

For automated checks, use `node --test desktop/test/*.test.mjs`. The launcher supports `--no-open`, `--port N`, `--config-dir PATH`, `--data-dir PATH`, and `--app-root PATH`. `--port 0` chooses a free ephemeral port for local smoke tests; Spotify sign-in requires a fixed port registered in the dashboard. The test runner can create a temporary `config.json` with fake credentials to skip interactive setup. The launcher always binds the server to `127.0.0.1` regardless of these options.
