# Install rotation on your computer

rotation starts a small local server and opens controls in your default browser. It does not install an always-running service. On the packaged Mac app, local output controls Spotify's desktop app on the same Mac through macOS Automation. Windows and Linux use a Spotify Connect device you choose. Spotify Premium is required for playback control.

## Before first launch

In your Spotify Developer Dashboard app, register **`http://127.0.0.1:3000/auth/callback`** as the exact redirect URI. Keep that address and port unchanged. The package contains no Spotify credentials; you enter your app's Client ID and Client Secret on rotation's local first-run page.

Open a successful **Desktop packages** run in the repository's GitHub Actions tab and download the artifact for your operating system and CPU. GitHub provides an outer ZIP containing the named archive below. Extract the outer ZIP, then extract the inner archive into a folder you will keep. Pull request artifacts are test builds and expire after 30 days.

| System | Inner archive | Launch |
| --- | --- | --- |
| Arch Linux x64 | `rotation-linux-x64.tar.gz` | Run `./Launch Rotation.sh` from the extracted `Rotation` folder. |
| Arch Linux arm64 | `rotation-linux-arm64.tar.gz` | Run `./Launch Rotation.sh` from the extracted `Rotation` folder. |
| Windows x64 | `rotation-windows-x64.zip` | Double-click `Launch Rotation.vbs`. If Windows Script Host is unavailable, run `Launch Rotation.cmd` and keep its console open. |
| macOS Apple Silicon | `rotation-macos-arm64.zip` | Move `Rotation.app` to Applications and open it. |
| macOS Intel | `rotation-macos-x64.zip` | Move `Rotation.app` to Applications and open it. |

The Linux packages target **Arch Linux** on x64 and arm64. Other distributions are **best effort** because their libraries and desktop integration can differ. On Arch Linux, you can run `./Install Desktop Shortcut.sh` once to add an application menu entry. Keep the extracted folder in place because the shortcut points to it. The macOS packages are unsigned and unnotarized, so macOS may block downloaded copies; a signed release is needed for a normal first launch.

On first launch, rotation shows its local setup page. Enter your Spotify Client ID and Client Secret, then continue to Spotify sign-in. The app binds to `127.0.0.1`, so it is available only on that computer.

If you used an older browser-player version, choose **Reconnect Spotify** after updating to grant device and playback-state access. Reconnecting the same Spotify account keeps your saved playlist choices.

On the packaged macOS app, open Spotify's desktop app on the same Mac and choose **This Mac** as Rotation's output. You can press **Play** to start local output directly. **Try local Mac playback** tests one selected song first; if Spotify confirms that exact song, Rotation switches to local Mac control and adopts it without replaying it. Play, Pause, Next, Previous, and seek then control that Mac. The saved shuffle order stays in Rotation. The test may replace Spotify's current playback. Local output does not require the Mac to appear in the Spotify Connect device list. macOS may ask to let Rotation control Spotify. Allow it, or change a previous denial in **System Settings → Privacy & Security → Automation** and retry. If the test or a control does not confirm the expected song, check Spotify's player and the message in Rotation before trying again. To return to a different device, choose **Spotify Connect**, then explicitly select an available device.

With local Mac output active, Rotation's local server watches Spotify and starts the next selected song after it detects that the current song ended. This watcher runs while Rotation is open, even if the browser tab is hidden or closed; **Quit rotation** stops it. Automatic advance in a downloaded Mac package has not yet been confirmed in a live playback test. Windows and Linux continue to use Spotify Connect and need an available, unrestricted device. The browser itself never plays audio.

## Launch, quit, and update

Launch rotation when you want to listen. Use **Quit rotation** in the browser to stop it, whether or not you are signed in. Closing the tab alone leaves the local server running; reopen `http://127.0.0.1:3000` to reach Quit. Launching rotation again while it is already running opens the existing local app. No service starts at boot.

For an update, use **Quit rotation** first, verify the old browser page no longer answers at `http://127.0.0.1:3000`, replace the extracted folder or `Rotation.app` with the newer package, and launch it again. On macOS, remove the old app copy from Applications before moving in the new one and open that new copy; an already-running app can otherwise reopen its old process. Your credentials and listening settings stay in your user profile. Use **Disconnect Spotify** in the app to remove its stored connection before deleting local data.

| System | Configuration | Session and settings data |
| --- | --- | --- |
| Linux | `~/.config/rotation` (or `$XDG_CONFIG_HOME/rotation`) | `~/.local/share/rotation` (or `$XDG_DATA_HOME/rotation`) |
| Windows | `%APPDATA%\Rotation` | `%LOCALAPPDATA%\Rotation\data` |
| macOS | `~/Library/Application Support/Rotation` | `~/Library/Application Support/Rotation/data` |

Back up configuration and data together if you want to preserve your connection. They contain secrets; keep backups private. Losing the session secret in configuration makes encrypted session data unreadable. A different launch port needs a matching Spotify redirect URI; the packaged launchers use port 3000 by default.
