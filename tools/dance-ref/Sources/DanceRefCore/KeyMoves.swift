import Foundation

public struct KeyMove: Equatable, Sendable {
  public var id: String
  public var t: Int
  public var name: String
  public init(id: String, t: Int, name: String) {
    self.id = id
    self.t = t
    self.name = name
  }
}

/// Key-move judging looks at player frames in [t − 200, t + 500] (§4.6), so a key move later than
/// `duration − KEY_TAIL_MS` cannot be judged fully.
public let KEY_TAIL_MS = 500
/// `--every` skips beats earlier than this, so the motion gate (§4.5) has reference motion before
/// the first key move.
public let KEY_LEAD_MS = 500

public func beatMs(bpm: Double) -> Double { 60000 / bpm }

/// Every `every`-th beat starting at `firstBeatMs`, kept within [KEY_LEAD_MS, duration − KEY_TAIL_MS].
/// The beat grid stays anchored on the first beat: skipped early beats still count toward `every`.
public func everyKBeats(bpm: Double, firstBeatMs: Int, every: Int, durationMs: Int) -> [Int] {
  guard bpm > 0, every >= 1 else { return [] }
  let step = beatMs(bpm: bpm) * Double(every)
  let last = durationMs - KEY_TAIL_MS
  var out: [Int] = []
  var i = 0
  while true {
    let t = Int((Double(firstBeatMs) + Double(i) * step).rounded())
    if t > last { break }
    if t >= KEY_LEAD_MS { out.append(t) }
    i += 1
    if i > 10_000 { break }
  }
  return out
}

/// Builds the key_moves array: ids `km01`, `km02`, … in time order; names from `names` or `Move N`.
public func makeKeyMoves(times: [Int], names: [String]) -> [KeyMove] {
  let sorted = times.sorted()
  return sorted.enumerated().map { i, t in
    let n = i + 1
    let id = n < 10 ? "km0\(n)" : "km\(n)"
    let given = i < names.count ? names[i].trimmingCharacters(in: .whitespaces) : ""
    return KeyMove(id: id, t: t, name: given.isEmpty ? "Move \(n)" : given)
  }
}

/// Problems with a key-move list, as human-readable warnings (none = fine).
public func keyMoveWarnings(_ times: [Int], durationMs: Int) -> [String] {
  var w: [String] = []
  if times.count < 8 || times.count > 16 {
    w.append("the contract wants 8 to 16 key moves, got \(times.count)")
  }
  for t in times where t > durationMs - KEY_TAIL_MS {
    w.append("key move at \(t) ms is within \(KEY_TAIL_MS) ms of the end; it cannot be judged fully")
  }
  let sorted = times.sorted()
  for (p, q) in zip(sorted, sorted.dropFirst()) where q - p < 700 {
    w.append("key moves at \(p) and \(q) ms are under 700 ms apart; their judging windows overlap")
  }
  return w
}
