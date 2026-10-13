import Foundation

// Matches GET /api/waiting.
struct WaitingSession: Decodable, Identifiable, Sendable {
    let id: String
    let label: String
    let room: String?
    let branch: String?
    let reason: String
    let since: Double  // milliseconds since the epoch

    var detail: String {
        let what = switch reason {
        case "question": "asked you a question"
        case "permission": "needs your permission"
        case "dialog": "needs your input"
        default: "finished, waiting for you"
        }
        return [room, what, "\(ago(since)) ago"].compactMap { $0 }.joined(separator: ", ")
    }
}

// Rounds like the page's ago() in web/src/status.ts, so the menu and the dashboard agree.
func ago(_ sinceMs: Double, now: Date = .now) -> String {
    let seconds = max(0, (now.timeIntervalSince1970 - sinceMs / 1000).rounded())
    if seconds < 60 { return "moments" }
    let minutes = Int((seconds / 60).rounded())
    if minutes < 60 { return "\(minutes) min" }
    let hours = Int((Double(minutes) / 60).rounded())
    return hours < 48 ? "\(hours) h" : "\(Int((Double(hours) / 24).rounded())) days"
}

func configuredPort() -> Int {
    let value = ProcessInfo.processInfo.environment["AGENT_ORRERY_PORT"]
        ?? UserDefaults.standard.string(forKey: "AGENT_ORRERY_PORT")
    return value.flatMap(Int.init) ?? 4777
}

// Matches GET /api/usage: your plan's windows, when the status line bridge is set up; {} when not.
struct PlanUsage: Decodable, Sendable {
    struct Forecast: Decodable, Sendable {
        let limitAt: Double?  // milliseconds since the epoch, when it reaches 100 % before the reset
    }
    struct Window: Decodable, Sendable {
        let percent: Double
        let resetsAt: Double?  // milliseconds since the epoch
        let forecast: Forecast?
    }
    let fiveHour: Window?
    let sevenDay: Window?

    // "Session 66 %, resets 18:30 · Week 11 %", or "limit around 17:40" when that comes first; nil without any window.
    var summary: String? {
        let format = Date.FormatStyle(date: .omitted, time: .shortened)
        let parts = [("Session", fiveHour), ("Week", sevenDay)].compactMap { name, window -> String? in
            guard let window else { return nil }
            let at = { (ms: Double) in Date(timeIntervalSince1970: ms / 1000).formatted(format) }
            // At this pace, the limit before the reset matters more than the reset itself.
            let when = window.forecast?.limitAt.map { ", limit around \(at($0))" } ?? window.resetsAt.map { ", resets \(at($0))" } ?? ""
            return "\(name) \(Int(window.percent.rounded())) %\(name == "Session" ? when : "")"
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

func fetchUsage(port: Int) async -> PlanUsage? {
    let url = URL(string: "http://127.0.0.1:\(port)/api/usage")!
    guard let (data, _) = try? await URLSession.shared.data(from: url) else { return nil }
    return try? JSONDecoder().decode(PlanUsage.self, from: data)
}

func fetchWaiting(port: Int) async throws -> [WaitingSession] {
    let url = URL(string: "http://127.0.0.1:\(port)/api/waiting")!
    let (data, response) = try await URLSession.shared.data(from: url)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    return try JSONDecoder().decode([WaitingSession].self, from: data)
}

// ObservableObject rather than @Observable: the macro plugins need full Xcode.
@MainActor
final class Poller: ObservableObject {
    let port = configuredPort()
    @Published var waiting: [WaitingSession] = []
    @Published var reachable = true
    @Published var usage: PlanUsage?

    init() {
        Task { await run() }
    }

    private func run() async {
        while true {
            do {
                waiting = try await fetchWaiting(port: port)
                reachable = true
                usage = await fetchUsage(port: port)
            } catch {
                waiting = []
                reachable = false
            }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    var dashboard: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    func link(to session: WaitingSession) -> URL {
        URL(string: "http://127.0.0.1:\(port)/#agent=\(session.id)")!
    }
}
