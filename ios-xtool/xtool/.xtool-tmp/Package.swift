// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "HELPBridge-Builder",
    platforms: [
        .iOS("16.0"),
    ],
    dependencies: [
        .package(name: "RootPackage", path: "../.."),
    ],
    targets: [
        .executableTarget(
    name: "HELPBridge-App",
    dependencies: [
        .product(name: "HELPBridge", package: "RootPackage"),
    ],
    linkerSettings: [
    .unsafeFlags([
        "-Xlinker", "-rpath", "-Xlinker", "@executable_path/Frameworks",
    ]),
]
)
    ]
)
