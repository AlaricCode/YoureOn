import Foundation

/// Running counts for the end-of-run report.
public struct RunStats: Equatable, Sendable {
  /// Frames the sampler picked (analysed by Vision).
  public var sampled = 0
  /// Sampled frames where Vision found nobody (left out of the JSON).
  public var noPerson = 0
  /// Sampled frames with more than one person (the largest one was kept).
  public var multiPerson = 0
  /// Frames written.
  public var emitted = 0
  /// Sum of c over every joint of every written frame.
  public var confSum = 0.0
  /// Per joint: written frames where c == 0 (not detected at all).
  public var absent = [Int](repeating: 0, count: Joints.count)
  /// Per joint: written frames where c < MIN_CONF (the scorer skips these).
  public var weak = [Int](repeating: 0, count: Joints.count)
  public var firstT: Int? = nil
  public var lastT: Int? = nil

  public init() {}

  public mutating func add(_ f: RefFrame) {
    emitted += 1
    if firstT == nil { firstT = f.t }
    lastT = f.t
    for j in 0..<Joints.count where 3 * j + 2 < f.k.count {
      let c = f.k[3 * j + 2]
      confSum += c
      if c <= 0 { absent[j] += 1 }
      if c < Joints.minConf { weak[j] += 1 }
    }
  }

  public var meanConfidence: Double {
    emitted == 0 ? 0 : confSum / Double(emitted * Joints.count)
  }
}

func pct(_ n: Int, _ of: Int) -> String {
  of == 0 ? "0%" : String(format: "%.0f%%", 100 * Double(n) / Double(of))
}

/// The printed summary plus warnings. Pure so it can be tested.
public func summaryLines(_ s: RunStats, durationMs: Int, fps: Int) -> (lines: [String], warnings: [String]) {
  var lines: [String] = []
  var warnings: [String] = []
  lines.append("frames: \(s.emitted) written / \(s.sampled) analysed at \(fps) fps")
  if let a = s.firstT, let b = s.lastT {
    lines.append("span: \(a)..\(b) ms of \(durationMs) ms")
    if a > 500 { warnings.append("first pose is at \(a) ms; the routine start has no pose") }
    if b < durationMs - 500 - 1000 / max(1, fps) {
      warnings.append("last pose is at \(b) ms; is the video shorter than the routine?")
    }
  }
  lines.append(String(format: "mean confidence: %.3f", s.meanConfidence))
  if s.noPerson > 0 {
    lines.append("no person: \(s.noPerson) frames (\(pct(s.noPerson, s.sampled)))")
    if s.noPerson * 20 > s.sampled { warnings.append("over 5% of frames found nobody") }
  }
  if s.multiPerson > 0 {
    lines.append("more than one person: \(s.multiPerson) frames (kept the largest)")
    warnings.append("someone else was in frame; the reference should show one dancer only")
  }
  var missing: [String] = []
  for j in 0..<Joints.count where s.weak[j] > 0 {
    missing.append(
      "  \(Joints.names[j]): below \(Joints.minConf) in \(s.weak[j]) (\(pct(s.weak[j], s.emitted))), absent in \(s.absent[j])"
    )
  }
  if missing.isEmpty {
    lines.append("missing joints: none")
  } else {
    lines.append("missing joints (frames):")
    lines.append(contentsOf: missing)
  }
  // Limbs the scorer uses: shoulders, elbows, wrists, hips, knees, ankles, neck.
  let scored = [5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18]
  for j in scored where s.emitted > 0 && s.weak[j] * 10 > s.emitted {
    warnings.append("\(Joints.names[j]) is weak in over 10% of frames; check framing and light")
  }
  if s.emitted > 0 && s.meanConfidence < 0.4 {
    warnings.append("mean confidence is low; record again with better light and contrast")
  }
  return (lines, warnings)
}
