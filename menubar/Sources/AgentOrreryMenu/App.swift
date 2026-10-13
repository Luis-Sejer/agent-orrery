import AppKit
import SwiftUI

@main
struct AgentOrreryMenuApp: App {
    @StateObject private var poller = Poller()

    init() {
        guard CommandLine.arguments.contains("--check") else { return }
        runCheck()
    }

    var body: some Scene {
        MenuBarExtra {
            if let summary = poller.usage?.summary {
                Text(summary)
                Divider()
            }
            if !poller.reachable {
                Text("Agent Orrery isn't running on port \(poller.port)")
            } else if poller.waiting.isEmpty {
                Text("Nothing is waiting on you")
            }
            ForEach(poller.waiting) { session in
                Button {
                    NSWorkspace.shared.open(poller.link(to: session))
                } label: {
                    Text(session.label)
                    Text(session.detail)
                }
            }
            Divider()
            Button("Open dashboard") { NSWorkspace.shared.open(poller.dashboard) }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        } label: {
            let count = poller.waiting.count
            // The menu bar draws template images in one colour, so the count carries the signal.
            Image(nsImage: orreryMark())
            if count > 0 { Text("\(count)") }
        }
    }
}

// One fetch, printed as text, for checking without a GUI.
func runCheck() -> Never {
    let port = configuredPort()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            let waiting = try await fetchWaiting(port: port)
            print("port \(port): \(waiting.count) waiting")
            if let summary = await fetchUsage(port: port)?.summary { print(summary) }
            for session in waiting { print("\(session.label) | \(session.detail) | #agent=\(session.id)") }
        } catch {
            print("Agent Orrery isn't running on port \(port)")
        }
        done.signal()
    }
    done.wait()
    exit(0)
}
