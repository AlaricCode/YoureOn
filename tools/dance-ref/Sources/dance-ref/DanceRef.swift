// dance-ref: reference video → RoutineData JSON (float keypoints), for
// `npx tsx scripts/dance-routine.ts import <out.json>`. See ../../README.md and
// docs/planning/DANCE-OFF.md §2 and §8.
//
// Pipeline: AVAssetReader (BGRA) → sample at --fps → VNImageRequestHandler with the orientation
// from the track's preferredTransform (so Vision sees the frame upright, like the phone does) →
// VNDetectHumanBodyPoseRequest pinned to Revision1 (the phone's revision) → the largest / most
// confident person → 19 joints in contract order, y flipped to a top-left origin.

import AVFoundation
import CoreMedia
import CoreVideo
import DanceRefCore
import Foundation
import ImageIO
import Vision

/// Contract joint order (DANCE-OFF.md §2), as Vision joint names.
let VISION_JOINTS: [VNHumanBodyPoseObservation.JointName] = [
  .nose, .leftEye, .rightEye, .leftEar, .rightEar, .neck,
  .leftShoulder, .rightShoulder, .leftElbow, .rightElbow, .leftWrist, .rightWrist,
  .root, .leftHip, .rightHip, .leftKnee, .rightKnee, .leftAnkle, .rightAnkle,
]

struct ToolError: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}

func eprint(_ s: String) {
  FileHandle.standardError.write(Data((s + "\n").utf8))
}

func fail(_ message: String, usage: Bool = false) -> Never {
  eprint("dance-ref: \(message)")
  if usage { eprint(USAGE) }
  exit(usage ? 64 : 1)
}

func visionPoints(_ obs: VNHumanBodyPoseObservation) throws -> [VisionPoint?] {
  let recognized = try obs.recognizedPoints(.all)
  return VISION_JOINTS.map { name -> VisionPoint? in
    guard let p = recognized[name] else { return nil }
    return VisionPoint(x: Double(p.location.x), y: Double(p.location.y), c: Double(p.confidence))
  }
}

@main
struct DanceRef {
  static func main() async {
    let opts: Options
    do {
      opts = try parseOptions(Array(CommandLine.arguments.dropFirst()))
    } catch let e as UsageError {
      fail(e.message, usage: true)
    } catch {
      fail("\(error)", usage: true)
    }
    if opts.help {
      print(USAGE)
      exit(0)
    }
    do {
      try await run(opts)
    } catch {
      fail("\(error)")
    }
  }

  static func run(_ o: Options) async throws {
    precondition(VISION_JOINTS.count == Joints.count)
    let url = URL(fileURLWithPath: o.video)
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw ToolError("no such file: \(o.video)")
    }

    var warnings: [String] = []
    if o.durationMs != 15000 {
      warnings.append("--duration-ms is \(o.durationMs); the contract requires 15000")
    }
    let bpm: Double
    if let b = o.bpm {
      bpm = b
    } else {
      bpm = DEFAULT_BPM
      warnings.append("no --bpm given; wrote \(Int(DEFAULT_BPM)). Set the track's real tempo")
    }

    // Video track + orientation.
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else { throw ToolError("no video track in \(o.video)") }
    let (transform, naturalSize, nominalFps) = try await track.load(
      .preferredTransform, .naturalSize, .nominalFrameRate)
    let assetDuration = try await asset.load(.duration)
    let videoMs = Int((CMTimeGetSeconds(assetDuration) * 1000).rounded())
    let orient = orientation(
      a: Double(transform.a), b: Double(transform.b), c: Double(transform.c),
      d: Double(transform.d))
    guard let cgOrient = CGImagePropertyOrientation(rawValue: orient.rawValue) else {
      throw ToolError("bad orientation \(orient.rawValue)")
    }
    print(
      "video: \(Int(naturalSize.width))x\(Int(naturalSize.height)) stored, "
        + String(format: "%.2f fps, ", nominalFps)
        + "\(videoMs) ms, orientation \(orient) (EXIF \(orient.rawValue))")
    if o.startMs >= videoMs { throw ToolError("--start-ms \(o.startMs) is past the end (\(videoMs) ms)") }
    if o.startMs + o.durationMs > videoMs {
      warnings.append(
        "the video ends at \(videoMs) ms, before start + duration (\(o.startMs + o.durationMs) ms)")
    }
    if nominalFps > 0 && Double(o.fps) > Double(nominalFps) + 0.5 {
      warnings.append("--fps \(o.fps) is above the video's \(String(format: "%.1f", nominalFps)) fps")
    }

    // Vision request: the SAME request and revision as the phone.
    guard
      VNDetectHumanBodyPoseRequest.supportedRevisions.contains(VNDetectHumanBodyPoseRequestRevision1)
    else {
      throw ToolError("this macOS does not support VNDetectHumanBodyPoseRequestRevision1")
    }
    let request = VNDetectHumanBodyPoseRequest()
    request.revision = VNDetectHumanBodyPoseRequestRevision1

    // Reader over [start, start + duration + 1 s of slack].
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw ToolError("cannot read the video track") }
    reader.add(output)
    reader.timeRange = CMTimeRange(
      start: CMTime(value: CMTimeValue(o.startMs), timescale: 1000),
      duration: CMTime(value: CMTimeValue(o.durationMs + 1000), timescale: 1000))
    guard reader.startReading() else {
      throw ToolError("cannot start reading: \(reader.error.map { "\($0)" } ?? "unknown error")")
    }

    var sampler = FrameSampler(fps: o.fps, durationMs: o.durationMs)
    var stats = RunStats()
    var frames: [RefFrame] = []
    var size: ImageSize? = nil

    while let sample = output.copyNextSampleBuffer() {
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      guard pts.isValid, let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
      let tRel = CMTimeGetSeconds(pts) * 1000 - Double(o.startMs)
      if tRel >= Double(o.durationMs) { break }
      guard sampler.accept(tMs: tRel) else { continue }

      let upright =
        size
        ?? uprightSize(
          bufferWidth: CVPixelBufferGetWidth(pixels), bufferHeight: CVPixelBufferGetHeight(pixels),
          orientation: orient)
      size = upright

      let people: [[Double]] = try autoreleasepool {
        let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: cgOrient, options: [:])
        try handler.perform([request])
        let observations = request.results ?? []
        return try observations.map { obs in
          try contractKeypoints(visionPoints(obs), mirrored: o.mirrored)
        }
      }

      stats.sampled += 1
      if people.count > 1 { stats.multiPerson += 1 }
      guard let pick = pickPerson(people, size: upright) else {
        stats.noPerson += 1
        continue
      }
      let frame = RefFrame(t: frameTimeMs(tRel), k: people[pick])
      if let last = frames.last, last.t >= frame.t { continue }  // keep t strictly increasing
      frames.append(frame)
      stats.add(frame)
      if stats.sampled % 45 == 0 {
        eprint(String(format: "  … %.1f s / %.1f s", tRel / 1000, Double(o.durationMs) / 1000))
      }
    }
    if reader.status == .failed {
      throw ToolError("reading failed: \(reader.error.map { "\($0)" } ?? "unknown error")")
    }
    guard let finalSize = size, !frames.isEmpty else {
      throw ToolError("no poses found in \(o.startMs)..\(o.startMs + o.durationMs) ms; nothing written")
    }

    // Key moves.
    var keyMoves: [KeyMove]? = nil
    switch o.keyMoves {
    case .omitted:
      print("key moves: none given; key_moves left out (the importer picks beats)")
    case .list, .every:
      let times = keyMoveTimes(o)
      warnings.append(contentsOf: keyMoveWarnings(times, durationMs: o.durationMs))
      if !o.keyMoveNames.isEmpty && o.keyMoveNames.count != times.count {
        warnings.append(
          "--key-move-names has \(o.keyMoveNames.count) names for \(times.count) key moves")
      }
      let moves = makeKeyMoves(times: times, names: o.keyMoveNames)
      keyMoves = moves
      print("key moves (\(moves.count)): " + moves.map { "\($0.t)" }.joined(separator: ", ") + " ms")
    }

    let routine = RoutineOutput(
      id: o.id, version: o.routineVersion, title: o.title, song: o.song, bpm: bpm,
      durationMs: o.durationMs, firstBeatMs: o.firstBeatMs, size: finalSize, frames: frames,
      keyMoves: keyMoves)
    let json = renderRoutineJSON(routine)
    let outURL = URL(fileURLWithPath: o.out)
    try FileManager.default.createDirectory(
      at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try json.write(to: outURL, atomically: true, encoding: .utf8)

    // Summary.
    print("routine: \(o.id) v\(o.routineVersion), upright \(finalSize.w)x\(finalSize.h)"
      + (o.mirrored ? ", un-mirrored (--mirrored)" : ""))
    let summary = summaryLines(stats, durationMs: o.durationMs, fps: o.fps)
    for line in summary.lines { print(line) }
    for w in warnings + summary.warnings { eprint("warning: \(w)") }
    print("wrote \(o.out)")
    print("next: npx tsx scripts/dance-routine.ts import \(o.out) --id \(o.id)")
  }
}
