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
        let what = reason == "question" ? "asked you a question" : "finished, waiting for you"
        return [room, what, "\(ago(since)) ago"].compactMap { $0 }.joined(separator: ", ")
    }
}

func ago(_ sinceMs: Double, now: Date = .now) -> String {
    let minutes = max(0, Int((now.timeIntervalSince1970 - sinceMs / 1000) / 60))
    if minutes < 1 { return "moments" }
    if minutes < 60 { return "\(minutes) min" }
    let hours = minutes / 60
    return hours < 48 ? "\(hours) h" : "\(hours / 24) days"
}

func configuredPort() -> Int {
    let value = ProcessInfo.processInfo.environment["AGENT_ORRERY_PORT"]
        ?? UserDefaults.standard.string(forKey: "AGENT_ORRERY_PORT")
    return value.flatMap(Int.init) ?? 4777
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

    init() {
        Task { await run() }
    }

    private func run() async {
        while true {
            do {
                waiting = try await fetchWaiting(port: port)
                reachable = true
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
