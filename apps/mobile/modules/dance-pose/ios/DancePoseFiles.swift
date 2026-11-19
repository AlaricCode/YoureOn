import CoreImage
import CoreVideo
import CryptoKit
import Foundation
import ImageIO

struct DancePoseError: LocalizedError {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? {
    return message
  }
}

/// One JPEG written for a requested snapshot time (DANCE-OFF.md §6.1 stopRound).
struct SnapshotFile {
  let tMs: Double
  let uri: String
  let width: Int
  let height: Int
  let bytes: Int
  let sha256: String

  var dictionary: [String: Any] {
    return [
      "t_ms": tMs,
      "uri": uri,
      "width": width,
      "height": height,
      "bytes": bytes,
      "sha256": sha256,
    ]
  }
}

/// Files the module writes: everything goes to Caches/dance-pose, which iOS may purge.
enum DancePoseFiles {
  static let maxAge: TimeInterval = 24 * 60 * 60

  static func directory() throws -> URL {
    let caches = try FileManager.default.url(
      for: .cachesDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let dir = caches.appendingPathComponent("dance-pose", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Deletes clips and snapshots older than a day (they are uploaded right after the round).
  static func pruneOldFiles() {
    guard let dir = try? directory(),
      let entries = try? FileManager.default.contentsOfDirectory(
        at: dir,
        includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles]
      )
    else {
      return
    }
    let cutoff = Date().addingTimeInterval(-maxAge)
    for url in entries {
      let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      if let modified, modified < cutoff {
        try? FileManager.default.removeItem(at: url)
      }
    }
  }

  static func hex(_ digest: SHA256.Digest) -> String {
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  static func sha256Hex(of data: Data) -> String {
    return hex(SHA256.hash(data: data))
  }

  /// Streams the file through SHA-256 in 1 MB chunks (a 15 s 720p clip is ~10 MB).
  static func sha256Hex(ofFileAt url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer {
      try? handle.close()
    }
    var hasher = SHA256()
    while true {
      let chunk: Data = try autoreleasepool {
        return try handle.read(upToCount: 1 << 20) ?? Data()
      }
      if chunk.isEmpty {
        break
      }
      hasher.update(data: chunk)
    }
    return hex(hasher.finalize())
  }
}

/// Pixel buffer -> small JPEG (long side <= 512 px, <= 200 KB). Used only on the snapshot queue.
final class SnapshotEncoder {
  static let maxLongSide: CGFloat = 512
  static let maxBytes = 200_000
  static let startQuality: CGFloat = 0.7
  static let minQuality: CGFloat = 0.2

  private let context = CIContext(options: [.cacheIntermediates: false])

  func encode(pixelBuffer: CVPixelBuffer, tMs: Double, to url: URL) throws -> SnapshotFile {
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    let extent = image.extent
    let longSide = max(extent.width, extent.height)
    guard longSide > 0 else {
      throw DancePoseError("empty frame")
    }
    let scale = min(1, Self.maxLongSide / longSide)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let rect = CGRect(
      x: scaled.extent.origin.x,
      y: scaled.extent.origin.y,
      width: (extent.width * scale).rounded(.down),
      height: (extent.height * scale).rounded(.down)
    )
    guard rect.width >= 1, rect.height >= 1,
      let cgImage = context.createCGImage(scaled, from: rect)
    else {
      throw DancePoseError("could not render the frame")
    }

    var quality = Self.startQuality
    var data = try jpeg(cgImage, quality: quality)
    while data.count > Self.maxBytes && quality > Self.minQuality {
      quality -= 0.1
      data = try jpeg(cgImage, quality: quality)
    }
    guard data.count <= Self.maxBytes else {
      throw DancePoseError("snapshot is over \(Self.maxBytes) bytes")
    }
    try data.write(to: url, options: .atomic)
    return SnapshotFile(
      tMs: tMs,
      uri: url.absoluteString,
      width: cgImage.width,
      height: cgImage.height,
      bytes: data.count,
      sha256: DancePoseFiles.sha256Hex(of: data)
    )
  }

  private func jpeg(_ image: CGImage, quality: CGFloat) throws -> Data {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data as CFMutableData,
        "public.jpeg" as CFString,
        1,
        nil
      )
    else {
      throw DancePoseError("JPEG encoder unavailable")
    }
    let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw DancePoseError("JPEG encoding failed")
    }
    return data as Data
  }
}
