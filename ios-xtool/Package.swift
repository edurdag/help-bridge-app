// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "HELPBridge",
    platforms: [
        .iOS(.v16),
        .macOS(.v14),
    ],
    products: [
        // An xtool project should contain exactly one library product,
        // representing the main app.
        .library(
            name: "HELPBridge",
            targets: ["HELPBridge"]
        ),
    ],
    targets: [
        .target(
            name: "HELPBridge",
            resources: [
                .copy("Resources")
            ],
            swiftSettings: [
                .unsafeFlags(["-strict-concurrency=minimal"])
            ]
        ),
    ]
)
