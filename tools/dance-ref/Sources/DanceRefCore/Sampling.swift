import Foundation

/// Picks decoded frames at roughly `fps`: the first frame at or after each target time.
/// Times are ms relative to the routine start (`--start-ms`). Frames before 0 or at/after the
/// duration are rejected.
public struct FrameSampler: Sendable {
  public let intervalMs: Double
  public let durationMs: Double
  /// Slack so 66.6666 vs 66.6667 style float noise does not skip a frame.
  public static let toleranceMs = 1.0
  public private(set) var nextMs: Double = 0

  public init(fps: Int, durationMs: Int) {
    intervalMs = 1000 / Double(max(1, fps))
    self.durationMs = Double(durationMs)
  }

  /// True when the frame at `tMs` should be analysed. Advances the next target past it.
  public mutating func accept(tMs: Double) -> Bool {
    guard tMs.isFinite, tMs >= -0.5, tMs < durationMs else { return false }
    guard tMs + FrameSampler.toleranceMs >= nextMs else { return false }
    while nextMs <= tMs + FrameSampler.toleranceMs { nextMs += intervalMs }
    return true
  }
}

/// The emitted frame time: whole ms since the routine start, never negative.
public func frameTimeMs(_ tMs: Double) -> Int {
  max(0, Int(tMs.rounded()))
}
