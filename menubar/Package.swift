// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "AgentOrreryMenu",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "AgentOrreryMenu", path: "Sources/AgentOrreryMenu")]
)
