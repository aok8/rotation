# Desktop packages

The desktop edition runs the same small Node server on `127.0.0.1:3000` and opens your default browser. It does not embed a browser or keep a background service after you choose **Quit rotation**. The browser needs internet access to Spotify, including its Web Playback SDK, and Spotify Premium for in-browser playback.

## Install and launch

1. Open a successful **Desktop packages** run in the repository's GitHub Actions tab and download the artifact for your operating system and CPU. GitHub downloads an outer ZIP containing `rotation-<platform>.zip` or `rotation-<platform>.tar.gz`; extract the outer ZIP and then the inner archive into a folder you will keep. Pull request artifacts are test builds and expire after 30 days.
2. Add **`http://127.0.0.1:3000/auth/callback`** as an exact redirect URI in your Spotify Developer Dashboard app.
3. Launch the app:
   - **Windows x64:** double-click `Launch Rotation.vbs` for a hidden console. If Windows Script Host is disabled, use `Launch Rotation.cmd`; keep its console open while listening.
   - **macOS Apple Silicon or Intel:** move `Rotation.app` to Applications and open it. These community builds are unsigned and unnotarized, so macOS may block downloaded copies. A signed and notarized release is needed for a normal first-launch experience. The app opens your default browser when allowed to run.
   - **Linux x64 or arm64:** run `./Launch Rotation.sh`. Optionally run `./Install Desktop Shortcut.sh` once to add an application menu entry. It points to the extracted folder, so keep that folder in place.
4. The first-run page asks for your Spotify Client ID and Client Secret. They are saved in your OS user profile, outside the app folder. Continue to Spotify sign-in in the browser.

Use **Quit rotation** in the app to stop the local server. Closing the browser tab alone leaves it running; reopen `http://127.0.0.1:3000` to access Quit. Opening a second copy while one is already running may report that port 3000 is in use; use the existing browser tab instead. No service is installed to start at boot.

The first-run setup uses port 3000 because the registered Spotify redirect URI must match exactly. Advanced `--port` overrides need a matching Dashboard redirect URI. User settings and session data persist between launches in a per-user config/data directory; replacing the app folder does not erase them. To fully disconnect, use the app's **Disconnect Spotify** action before deleting local profile data. Back up the profile data only if you want to preserve that connection; it contains secrets and should remain private.

## Build from source

Requires Node 24, npm, and the compiled `desktop/launcher.mjs` runtime. Build with:

```sh
npm --prefix web ci
npm --prefix server ci
npm --prefix web run build
npm --prefix server run build
npm --prefix server prune --omit=dev
node desktop/package.mjs --platform=linux --arch=x64 --node="$(command -v node)" --out=dist-desktop/Rotation
```

The packager stages an allowlist: compiled server and web output, production server dependencies, launcher, and a Node binary. It refuses `.env`, known session/config files, logs, and symlinks. CI builds archives separately on native Linux, macOS, and Windows runners. Only the Linux package can be smoke tested on a Linux development machine; Windows and macOS behavior needs testing on those operating systems. The macOS artifacts are unsigned and notarization is not configured.
