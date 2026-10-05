import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift verify-macos-launch.swift <app-bundle>\n", stderr)
    exit(2)
}

let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
    .resolvingSymlinksInPath().standardizedFileURL
let apps = NSWorkspace.shared.runningApplications.filter { running in
    running.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == bundle
}
guard apps.contains(where: { $0.isFinishedLaunching }) else {
    fputs("Launch Services did not see a finished AppKit launch.\n", stderr)
    exit(1)
}
print("Launch Services observed a finished AppKit launch.")
