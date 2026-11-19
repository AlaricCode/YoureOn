import CoreGraphics
import Vision

/// Turns a Vision body-pose observation into the contract's raw person (DANCE-OFF.md §2):
/// `k: [x, y, c] × 19` in the fixed joint order below, x and y in [0, 1] of the UPRIGHT,
/// UNMIRRORED image with a top-left origin, c in [0, 1]. A missing joint is 0, 0, 0.
enum PoseExtraction {
  /// The contract's joint order (indices 0..18). Keep in sync with `JOINT_ORDER` in src/frame.ts
  /// (a source-scanning test compares the two).
  static let jointOrder: [VNHumanBodyPoseObservation.JointName] = [
    .nose,
    .leftEye,
    .rightEye,
    .leftEar,
    .rightEar,
    .neck,
    .leftShoulder,
    .rightShoulder,
    .leftElbow,
    .rightElbow,
    .leftWrist,
    .rightWrist,
    .root,
    .leftHip,
    .rightHip,
    .leftKnee,
    .rightKnee,
    .leftAnkle,
    .rightAnkle,
  ]

  static let valuesPerPerson = 57

  /// Most people reported per frame. The scorer needs two; a few more lets JS count extras.
  static let maxPeople = 6

  /// The pinned request: the phone, the macOS reference tool and any rerun must use the same
  /// model revision, or the joints move under the scorer.
  static func makeRequest() -> VNDetectHumanBodyPoseRequest {
    let request = VNDetectHumanBodyPoseRequest()
    request.revision = VNDetectHumanBodyPoseRequestRevision1
    return request
  }

  static func keypoints(of observation: VNHumanBodyPoseObservation) -> [Double] {
    var out = [Double](repeating: 0, count: valuesPerPerson)
    guard let points = try? observation.recognizedPoints(.all) else {
      return out
    }
    for (index, joint) in jointOrder.enumerated() {
      guard let point = points[joint], point.confidence > 0 else {
        continue
      }
      // Vision's normalized space has a bottom-left origin; the contract's is top-left.
      out[index * 3] = round4(clamp01(Double(point.location.x)))
      out[index * 3 + 1] = round4(clamp01(1 - Double(point.location.y)))
      out[index * 3 + 2] = round4(clamp01(Double(point.confidence)))
    }
    return out
  }

  static func round4(_ value: Double) -> Double {
    return (value * 10_000).rounded() / 10_000
  }

  static func clamp01(_ value: Double) -> Double {
    guard value.isFinite else {
      return 0
    }
    return min(1, max(0, value))
  }
}
