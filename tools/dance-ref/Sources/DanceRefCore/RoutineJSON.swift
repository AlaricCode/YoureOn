import Foundation

/// One analysed frame: `t` ms since the routine start, `k` the 57 contract values (floats).
public struct RefFrame: Equatable, Sendable {
  public var t: Int
  public var k: [Double]
  public init(t: Int, k: [Double]) {
    self.t = t
    self.k = k
  }
}

/// Everything the JSON needs. Its keys are RoutineData (DANCE-OFF.md §2) with float keypoints;
/// `scripts/dance-routine.ts import` validates, quantizes and writes the routine module.
public struct RoutineOutput: Equatable, Sendable {
  public var id: String
  public var version: Int
  public var title: String
  public var song: String
  public var bpm: Double
  public var durationMs: Int
  public var firstBeatMs: Int
  public var size: ImageSize
  public var frames: [RefFrame]
  /// nil = leave key_moves out and let the importer pick beats.
  public var keyMoves: [KeyMove]?

  public init(
    id: String, version: Int, title: String, song: String, bpm: Double, durationMs: Int,
    firstBeatMs: Int, size: ImageSize, frames: [RefFrame], keyMoves: [KeyMove]?
  ) {
    self.id = id
    self.version = version
    self.title = title
    self.song = song
    self.bpm = bpm
    self.durationMs = durationMs
    self.firstBeatMs = firstBeatMs
    self.size = size
    self.frames = frames
    self.keyMoves = keyMoves
  }
}

/// The contract's count-in (§2) is fixed at 3 beats.
public let COUNT_IN_BEATS = 3

/// JSON string literal (RFC 8259 escaping).
public func jsonString(_ s: String) -> String {
  var out = "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if u.value < 0x20 {
        out += String(format: "\\u%04x", u.value)
      } else {
        out.unicodeScalars.append(u)
      }
    }
  }
  out += "\""
  return out
}

/// Fixed 6-decimal number with trailing zeros removed: 0.5 → "0.5", 1 → "1", 0 → "0".
/// Non-finite values become "0" (JSON has no NaN). Locale independent.
public func jsonNumber(_ v: Double) -> String {
  guard v.isFinite else { return "0" }
  var s = String(format: "%.6f", v)
  if s.contains(".") {
    while s.hasSuffix("0") { s.removeLast() }
    if s.hasSuffix(".") { s.removeLast() }
  }
  if s == "-0" { s = "0" }
  return s
}

/// Renders the RoutineData JSON: one frame per line so diffs and eyeballing stay readable.
public func renderRoutineJSON(_ r: RoutineOutput) -> String {
  var lines: [String] = []
  lines.append("{")
  lines.append("  \"schema_version\": 1,")
  lines.append("  \"id\": \(jsonString(r.id)),")
  lines.append("  \"version\": \(r.version),")
  lines.append("  \"title\": \(jsonString(r.title)),")
  lines.append("  \"song\": \(jsonString(r.song)),")
  lines.append("  \"bpm\": \(jsonNumber(r.bpm)),")
  lines.append("  \"duration_ms\": \(r.durationMs),")
  lines.append("  \"first_beat_ms\": \(r.firstBeatMs),")
  lines.append("  \"count_in_beats\": \(COUNT_IN_BEATS),")
  lines.append("  \"w\": \(r.size.w),")
  lines.append("  \"h\": \(r.size.h),")
  lines.append("  \"mirrored_source\": false,")
  lines.append("  \"source\": \"vision\",")
  if r.frames.isEmpty {
    lines.append("  \"frames\": [],")
  } else {
    lines.append("  \"frames\": [")
    for (i, f) in r.frames.enumerated() {
      let k = f.k.map(jsonNumber).joined(separator: ",")
      let comma = i == r.frames.count - 1 ? "" : ","
      lines.append("    {\"t\": \(f.t), \"k\": [\(k)]}\(comma)")
    }
    lines.append("  ],")
  }
  if let moves = r.keyMoves {
    if moves.isEmpty {
      lines.append("  \"key_moves\": [],")
    } else {
      lines.append("  \"key_moves\": [")
      for (i, m) in moves.enumerated() {
        let comma = i == moves.count - 1 ? "" : ","
        lines.append(
          "    {\"id\": \(jsonString(m.id)), \"t\": \(m.t), \"name\": \(jsonString(m.name))}\(comma)"
        )
      }
      lines.append("  ],")
    }
  }
  lines.append("  \"media\": {\"video\": null, \"audio\": null}")
  lines.append("}")
  return lines.joined(separator: "\n") + "\n"
}
