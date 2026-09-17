// swift-tools-version: 5.9
import PackageDescription

// CodeQL's Swift autobuild needs a package for the standalone Vision OCR helper.
let package = Package(
    name: "LibratoryVision",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "vision-words", targets: ["VisionWords"])],
    targets: [.executableTarget(name: "VisionWords", path: "scripts", sources: ["vision-words.swift"])]
)
