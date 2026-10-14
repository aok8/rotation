# Install rotation on your computer

rotation starts a small local server and opens controls in your default browser. It does not install an always-running service. Open Spotify on the computer, phone, or speaker where you want audio, then choose that device in rotation. Spotify Premium is required for playback control.

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

Playback on macOS uses Spotify Connect, just as it does on Windows and Linux. Open Spotify's desktop app on the Mac, select that device in Rotation, and press **Play**. Rotation no longer requests macOS Automation permission or controls Spotify through AppleScript. A successful Spotify API response does not prove the desktop app played audio; use the device and playback status shown in Rotation to confirm it.

If the Mac desktop device appears but Play or Next stalls, capture **Copy playback diagnostics** in Rotation before quitting. For a controlled test of one Spotify Player call at a time, follow [the Mac Connect bisect](../docs/mac-connect-bisect.md). It uses the saved local connection without putting a Spotify token in a command or report.

## Launch, quit, and update

Launch rotation when you want to listen. Use **Quit rotation** in the browser to stop it, whether or not you are signed in. Closing the tab alone leaves the local server running; reopen `http://127.0.0.1:3000` to reach Quit. Launching rotation again while it is already running opens the existing local app. No service starts at boot.

For an update, quit rotation, replace the extracted folder or `Rotation.app` with the newer package, and launch it again. Your credentials and listening settings stay in your user profile. Use **Disconnect Spotify** in the app to remove its stored connection before deleting local data.

| System | Configuration | Session and settings data |
| --- | --- | --- |
| Linux | `~/.config/rotation` (or `$XDG_CONFIG_HOME/rotation`) | `~/.local/share/rotation` (or `$XDG_DATA_HOME/rotation`) |
| Windows | `%APPDATA%\Rotation` | `%LOCALAPPDATA%\Rotation\data` |
| macOS | `~/Library/Application Support/Rotation` | `~/Library/Application Support/Rotation/data` |

Back up configuration and data together if you want to preserve your connection. They contain secrets; keep backups private. Losing the session secret in configuration makes encrypted session data unreadable. A different launch port needs a matching Spotify redirect URI; the packaged launchers use port 3000 by default.
