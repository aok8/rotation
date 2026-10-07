import AppKit
import Darwin
import Foundation

final class RotationLauncher: NSObject, NSApplicationDelegate {
    private var child: Process?
    private var quitting = false
    private let arguments = Array(CommandLine.arguments.dropFirst())
    private var browserTimer: Timer?
    private var browserRequestInFlight = false
    private var openedSetup = false
    private var openedMain = false
    private var sawLocalService = false
    private var launchDeadline = Date.distantFuture
    private var expectedBuildId: String?

    private var noOpen: Bool { arguments.contains("--no-open") }
    private var port: Int {
        guard let index = arguments.firstIndex(of: "--port"),
              arguments.indices.contains(index + 1),
              let value = Int(arguments[index + 1]) else { return 3000 }
        return value
    }
    private var browserURL: URL? {
        guard (1...65535).contains(port) else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("Rotation is starting its local launcher.")
        guard let resources = Bundle.main.resourceURL else {
            NSLog("Rotation cannot find its bundled resources.")
            NSApp.terminate(nil)
            return
        }

        let root = resources.appendingPathComponent("Rotation", isDirectory: true)
        do {
            let manifest = root.appendingPathComponent("build-manifest.json")
            let data = try Data(contentsOf: manifest)
            let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let buildId = fields?["buildId"] as? String,
                  buildId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
                throw NSError(domain: "Rotation", code: 1)
            }
            expectedBuildId = buildId
        } catch {
            showAlert(title: "Rotation could not start", message: "The bundled build information is missing or invalid. Reinstall Rotation and try again.")
            NSApp.terminate(nil)
            return
        }
        let process = Process()
        process.executableURL = root.appendingPathComponent("runtime/node")
        process.arguments = [
            root.appendingPathComponent("desktop/launcher.mjs").path,
            "--app-root", root.path,
        ] + arguments + (noOpen ? [] : ["--no-open"])
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.browserTimer?.invalidate()
                NSLog("Rotation local launcher exited with status %d.", finished.terminationStatus)
                if self.quitting {
                    NSApp.reply(toApplicationShouldTerminate: true)
                } else {
                    if finished.terminationStatus == 16 {
                        self.showAlert(
                            title: "Another Rotation is running",
                            message: "The browser is connected to a different Rotation build. Open that Rotation page, choose Quit rotation, then reopen this app. Your saved Spotify settings will remain available."
                        )
                    } else if finished.terminationStatus != 0 {
                        self.showAlert(
                            title: "Rotation could not start",
                            message: "Check the local setup and try opening Rotation again. If port \(self.port) is occupied, quit the other app first."
                        )
                    } else if !self.noOpen && !self.openedSetup && !self.openedMain {
                        self.openBrowser()
                    }
                    NSApp.terminate(nil)
                }
            }
        }

        do {
            try process.run()
            child = process
            if !noOpen && browserURL != nil {
                launchDeadline = Date().addingTimeInterval(20)
                browserTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
                    self?.checkBrowserReady()
                }
                checkBrowserReady()
            }
        } catch {
            NSLog("Rotation launcher could not start: %@", String(describing: error))
            showAlert(title: "Rotation could not start", message: "The bundled runtime could not launch. Reinstall Rotation and try again.")
            NSApp.terminate(nil)
        }
    }

    private func showAlert(title: String, message: String) {
        if noOpen {
            FileHandle.standardError.write(Data("\(title): \(message)\n".utf8))
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func openBrowser() {
        guard let browserURL else { return }
        if !NSWorkspace.shared.open(browserURL) {
            showAlert(
                title: "Open Rotation in your browser",
                message: "The default browser did not open. Visit \(browserURL.absoluteString) manually while Rotation is running."
            )
        }
    }

    private func checkBrowserReady() {
        if !sawLocalService && Date() > launchDeadline {
            browserTimer?.invalidate()
            showAlert(
                title: "Rotation did not start",
                message: "Its local service did not open on 127.0.0.1:\(port). Quit Rotation and try again. If this persists, reinstall the package for your Mac's processor."
            )
            NSApp.terminate(nil)
            return
        }
        guard !browserRequestInFlight, let browserURL, !openedMain else { return }
        browserRequestInFlight = true
        var request = URLRequest(url: browserURL.appendingPathComponent("api/session"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.browserRequestInFlight = false
                guard !self.quitting, self.child?.isRunning == true else { return }
                guard let status = (response as? HTTPURLResponse)?.statusCode else { return }
                if status == 200,
                   let data,
                   let session = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   session["desktop"] as? Bool == true,
                   session["desktopBuildId"] as? String == self.expectedBuildId {
                    self.sawLocalService = true
                    NSLog("Rotation local service is ready.")
                    self.openedMain = true
                    self.browserTimer?.invalidate()
                    self.openBrowser()
                } else if status == 404 && !self.openedSetup {
                    self.checkSetupReady()
                }
            }
        }.resume()
    }

    private func checkSetupReady() {
        guard let browserURL else { return }
        browserRequestInFlight = true
        var request = URLRequest(url: browserURL)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.browserRequestInFlight = false
                guard !self.quitting, self.child?.isRunning == true else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let data,
                   let html = String(data: data, encoding: .utf8),
                   html.contains("<title>Set up rotation</title>"),
                   let buildId = self.expectedBuildId,
                   html.contains("<meta name=\"rotation-build-id\" content=\"\(buildId)\">") {
                    self.sawLocalService = true
                    NSLog("Rotation first-run setup is ready.")
                    self.openedSetup = true
                    self.openBrowser()
                }
            }
        }.resume()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child, child.isRunning else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        child.terminate()
        // The Node launcher normally shuts its server down promptly. A stuck
        // child must not leave the app permanently waiting to quit.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if child.isRunning { _ = Darwin.kill(child.processIdentifier, SIGKILL) }
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !noOpen && (openedMain || openedSetup) { openBrowser() }
        return true
    }
}

let app = NSApplication.shared
let launcher = RotationLauncher()
app.delegate = launcher
app.run()
