// swift-tools-version: 5.9
// dance-ref: turns a reference dance video into RoutineData JSON (docs/planning/DANCE-OFF.md §8).
// The Vision request and revision match the phone (VNDetectHumanBodyPoseRequestRevision1).

import PackageDescription

let package = Package(
  name: "dance-ref",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "dance-ref", targets: ["dance-ref"])
  ],
  targets: [
    // Pure logic (no AVFoundation / Vision): args, joint order, mirroring, orientation,
    // sampling, person pick, key moves, JSON output, summary. Unit tested.
    .target(name: "DanceRefCore"),
    // The CLI: AVAssetReader + VNDetectHumanBodyPoseRequest, glued to DanceRefCore.
    .executableTarget(
      name: "dance-ref",
      dependencies: ["DanceRefCore"]
    ),
    .testTarget(
      name: "DanceRefCoreTests",
      dependencies: ["DanceRefCore"]
    ),
  ]
)
