import Foundation

/// The fixed joint order shared with the phone and the scorer (DANCE-OFF.md §2).
/// Index i of a keypoint array `k` holds joint i as `[x, y, c]` at `k[3i], k[3i+1], k[3i+2]`.
public enum Joints {
  public static let names: [String] = [
    "nose", "leftEye", "rightEye", "leftEar", "rightEar", "neck",
    "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist",
    "root", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
  ]

  public static let count = 19
  public static let valuesPerPerson = 57

  /// Left/right partner of each joint (nose, neck and root map to themselves).
  public static let mirrorIndex: [Int] = [
    0,  // nose
    2, 1,  // eyes
    4, 3,  // ears
    5,  // neck
    7, 6,  // shoulders
    9, 8,  // elbows
    11, 10,  // wrists
    12,  // root
    14, 13,  // hips
    16, 15,  // knees
    18, 17,  // ankles
  ]

  /// The scorer's MIN_CONF (§4.1). Used only for the summary's "missing" counts here.
  public static let minConf = 0.3
}

/// One joint as Vision reports it in the UPRIGHT image: normalized, bottom-left origin.
public struct VisionPoint: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var c: Double
  public init(x: Double, y: Double, c: Double) {
    self.x = x
    self.y = y
    self.c = c
  }
}

/// Clamp to [0, 1]; NaN and infinities become 0 so the JSON never carries them.
public func unit(_ v: Double) -> Double {
  guard v.isFinite else { return 0 }
  return min(1, max(0, v))
}

/// Vision points (indexed in `Joints.names` order, nil = not reported) to the contract's raw person:
/// 57 values, x/y in [0,1] with a TOP-LEFT origin, c in [0,1], a missing joint is [0, 0, 0].
/// `mirrored` un-mirrors a mirrored source: x → 1 − x and every left/right pair swaps labels.
public func contractKeypoints(_ points: [VisionPoint?], mirrored: Bool) -> [Double] {
  var k = [Double](repeating: 0, count: Joints.valuesPerPerson)
  for i in 0..<Joints.count {
    guard i < points.count, let p = points[i] else { continue }
    let c = unit(p.c)
    guard c > 0 else { continue }
    var x = unit(p.x)
    let y = unit(1 - unit(p.y))
    var dst = i
    if mirrored {
      x = 1 - x
      dst = Joints.mirrorIndex[i]
    }
    k[3 * dst] = x
    k[3 * dst + 1] = y
    k[3 * dst + 2] = c
  }
  return k
}

/// Upright image size in pixels for an aspect-correct person size.
public struct ImageSize: Equatable, Sendable {
  public var w: Int
  public var h: Int
  public init(w: Int, h: Int) {
    self.w = w
    self.h = h
  }
}

/// Selection score for one candidate person (57 contract values):
/// joint bounding-box area in pixels × mean confidence over all 19 joints.
/// A frame's chosen dancer is the candidate with the largest score (ties: higher mean confidence).
public func personScore(_ k: [Double], size: ImageSize) -> (score: Double, meanConf: Double) {
  var minX = Double.infinity
  var minY = Double.infinity
  var maxX = -Double.infinity
  var maxY = -Double.infinity
  var sumC = 0.0
  for i in 0..<Joints.count where 3 * i + 2 < k.count {
    let c = k[3 * i + 2]
    sumC += c
    guard c > 0 else { continue }
    minX = min(minX, k[3 * i])
    maxX = max(maxX, k[3 * i])
    minY = min(minY, k[3 * i + 1])
    maxY = max(maxY, k[3 * i + 1])
  }
  let meanConf = sumC / Double(Joints.count)
  guard minX.isFinite, maxX.isFinite else { return (0, meanConf) }
  let area = (maxX - minX) * Double(size.w) * (maxY - minY) * Double(size.h)
  return (area * meanConf, meanConf)
}

/// Index of the largest / most confident person, or nil when there is nobody.
public func pickPerson(_ people: [[Double]], size: ImageSize) -> Int? {
  var best: Int?
  var bestScore = -1.0
  var bestConf = -1.0
  for (i, k) in people.enumerated() {
    let s = personScore(k, size: size)
    if s.meanConf <= 0 { continue }
    if s.score > bestScore || (s.score == bestScore && s.meanConf > bestConf) {
      best = i
      bestScore = s.score
      bestConf = s.meanConf
    }
  }
  return best
}
