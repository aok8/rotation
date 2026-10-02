# rotation desktop

rotation runs locally on your computer and opens in your default browser. It does not install a background service or a separate music player window. Spotify provides the music, and Spotify Premium is required for browser playback.

Get the package for your operating system from a successful **Desktop packages** run in the repository's GitHub Actions tab, then follow [the installation guide](INSTALL.md). The Linux packages target **Arch Linux** on x64 and arm64; other distributions are best effort. Windows x64 and macOS Apple Silicon and Intel packages are also available.

Before first launch, add **`http://127.0.0.1:3000/auth/callback`** as an exact redirect URI in your Spotify Developer Dashboard app. The first-run page asks for that app's Client ID and Client Secret. rotation saves them in your user profile, outside the extracted package, and then opens Spotify sign-in in your browser.

Use **Quit rotation** in the browser to stop the local app. Closing the browser tab leaves it running; reopen `http://127.0.0.1:3000` to reach Quit. Launch rotation again when you want to listen. It does not start automatically with your computer.

Your saved connection and playlist settings stay in your user profile when you replace the app package. The [installation guide](INSTALL.md) lists the data locations and platform-specific launch steps.
