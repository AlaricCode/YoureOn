import Foundation

/// EXIF orientation codes, with raw values equal to `CGImagePropertyOrientation`'s.
public enum ExifOrientation: UInt32, Sendable, CaseIterable {
  case up = 1
  case upMirrored = 2
  case down = 3
  case downMirrored = 4
  case leftMirrored = 5
  case right = 6
  case rightMirrored = 7
  case left = 8

  /// True when the stored frame is rotated a quarter turn, so the upright size is (h, w).
  public var swapsWidthHeight: Bool {
    switch self {
    case .leftMirrored, .right, .rightMirrored, .left: return true
    case .up, .upMirrored, .down, .downMirrored: return false
    }
  }
}

/// Maps a video track's `preferredTransform` (a, b, c, d; translation ignored) to the orientation that
/// makes Vision see the frame upright, the way a player sees it.
///
/// CGAffineTransform maps (x, y) → (a·x + c·y, b·x + d·y). For example the iPhone portrait clip
/// (0, 1, −1, 0) sends the stored top row to the right edge of the display, which is EXIF 6 (`.right`).
/// Non-axis-aligned transforms (never produced by cameras) fall back to `.up`.
public func orientation(a: Double, b: Double, c: Double, d: Double) -> ExifOrientation {
  let ra = Int(a.rounded())
  let rb = Int(b.rounded())
  let rc = Int(c.rounded())
  let rd = Int(d.rounded())
  switch (ra, rb, rc, rd) {
  case (1, 0, 0, 1): return .up
  case (-1, 0, 0, -1): return .down
  case (0, 1, -1, 0): return .right
  case (0, -1, 1, 0): return .left
  case (-1, 0, 0, 1): return .upMirrored
  case (1, 0, 0, -1): return .downMirrored
  case (0, 1, 1, 0): return .leftMirrored
  case (0, -1, -1, 0): return .rightMirrored
  default: return .up
  }
}

/// Upright pixel size from the decoded buffer size and the orientation.
public func uprightSize(bufferWidth: Int, bufferHeight: Int, orientation: ExifOrientation)
  -> ImageSize
{
  orientation.swapsWidthHeight
    ? ImageSize(w: bufferHeight, h: bufferWidth)
    : ImageSize(w: bufferWidth, h: bufferHeight)
}
