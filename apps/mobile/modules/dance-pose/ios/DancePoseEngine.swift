import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import Vision

/// A value shared between queues, guarded by a lock.
final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) {
    self.value = value
  }

  func get() -> Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func set(_ newValue: Value) {
    lock.lock()
    value = newValue
    lock.unlock()
  }
}

/// One round (startRound -> stopRound). Lives on the capture queue only.
private struct RoundState {
  let id: String
  /// Requested snapshot times in ms since t0, ascending.
  let snapshotTargets: [Double]
  var nextSnapshot = 0
  /// PTS of the round's first frame. nil until that frame arrives.
  var t0: CMTime?
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var clipURL: URL?
  var writerFailed = false

  init(id: String, snapshotTargets: [Double]) {
    self.id = id
    self.snapshotTargets = snapshotTargets
  }
}

/// Collects the two halves of stopRound (writer + snapshots). Written before the dispatch group
/// is left and read only in its notify block, so the group orders the accesses.
private final class StopResultBox: @unchecked Sendable {
  var clipURL: URL?
  var snapshots: [SnapshotFile] = []
}

/// The camera + pose + recording pipeline behind DancePoseView (DANCE-OFF.md §6.1).
///
/// Threading (no state is shared without a queue or a lock):
/// - sessionQueue: session configuration and start/stop (`configured`, `configurationFailed`,
///   `observerTokens`).
/// - captureQueue: the sample-buffer delegate. Owns the clock (`sessionStartPTS`), the round
///   (`round`: writer, t0, snapshot schedule), throttling and the fps estimate. Never blocks: Vision
///   and JPEG work are handed to their own queues.
/// - visionQueue: VNDetectHumanBodyPoseRequest (`poseRequest`).
/// - snapshotQueue: JPEG encoding and the per-round snapshot lists (`snapshotsByRound`).
/// - main: every callback into the view (events, promise results go through the Promise itself).
/// Cross-queue flags (`wantsRunning`, `maxFps`, `visionBusy`) are `Locked`.
final class DancePoseEngine: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
  @unchecked Sendable
{
  typealias Payload = [String: Any]

  static let defaultMaxFps: Double = 30
  /// startRound needs frames: a session whose last frame is older than this is not running.
  private static let frameStaleAfter: TimeInterval = 1.5

  let session = AVCaptureSession()

  /// Called on the main thread with an onPoses / onStatus payload. Set once by the view.
  var posesHandler: ((Payload) -> Void)?
  var statusHandler: ((Payload) -> Void)?
  /// Called on the main thread each time the session starts running (preview orientation).
  var runningHandler: (() -> Void)?

  private let sessionQueue = DispatchQueue(label: "dev.youreon.dancepose.session")
  private let captureQueue = DispatchQueue(
    label: "dev.youreon.dancepose.capture",
    qos: .userInitiated
  )
  private let visionQueue = DispatchQueue(label: "dev.youreon.dancepose.vision", qos: .userInitiated)
  private let snapshotQueue = DispatchQueue(label: "dev.youreon.dancepose.snapshot", qos: .utility)
  private let videoOutput = AVCaptureVideoDataOutput()

  // Cross-queue.
  private let wantsRunning = Locked(false)
  private let maxFps = Locked(DancePoseEngine.defaultMaxFps)
  private let visionBusy = Locked(false)

  // sessionQueue only.
  private var configured = false
  private var configurationFailed = false
  private var observerTokens: [NSObjectProtocol] = []

  // captureQueue only.
  private var sessionStartPTS: CMTime?
  private var lastPoseDispatchPTS: CMTime?
  private var lastFrameUptime: TimeInterval = 0
  private var fpsEMA: Double = 0
  private var round: RoundState?

  // visionQueue only.
  private let poseRequest = PoseExtraction.makeRequest()

  // captureQueue only: captureStill() callers waiting for the next pose frame.
  private var stillRequests: [(Payload) -> Void] = []

  // snapshotQueue only.
  private let encoder = SnapshotEncoder()
  private let stillEncoder = SnapshotEncoder(
    maxLongSide: SnapshotEncoder.stillMaxLongSide,
    maxBytes: SnapshotEncoder.stillMaxBytes,
    startQuality: SnapshotEncoder.stillQuality
  )
  private var snapshotsByRound: [String: [SnapshotFile]] = [:]

  override init() {
    super.init()
    snapshotQueue.async {
      DancePoseFiles.pruneOldFiles()
    }
  }

  deinit {
    for token in observerTokens {
      NotificationCenter.default.removeObserver(token)
    }
  }

  // MARK: - Control (any thread; the view calls these on main)

  func setActive(_ active: Bool) {
    wantsRunning.set(active)
    sessionQueue.async { [weak self] in
      self?.applyRunningState()
    }
  }

  func setMaxFps(_ value: Double) {
    let fps = value.isFinite ? value : DancePoseEngine.defaultMaxFps
    maxFps.set(min(60, max(1, fps)))
  }

  /// Arms a round. The next captured frame becomes t0: its PTS starts the recording and every
  /// onPoses `t` from then on is ms since that frame. `completion` runs on the capture queue.
  func startRound(snapshotAtMs: [Double], completion: @escaping (Bool, String?) -> Void) {
    let targets = snapshotAtMs.filter { $0.isFinite && $0 >= 0 }.sorted()
    captureQueue.async { [weak self] in
      guard let self else {
        completion(false, "camera view is gone")
        return
      }
      let fresh = ProcessInfo.processInfo.systemUptime - self.lastFrameUptime
      guard self.lastFrameUptime > 0, fresh < DancePoseEngine.frameStaleAfter else {
        completion(false, "camera is not running")
        return
      }
      if let previous = self.round {
        self.discard(previous)
      }
      self.round = RoundState(id: UUID().uuidString.lowercased(), snapshotTargets: targets)
      completion(true, nil)
    }
  }

  /// One full-size JPEG of the next frame that goes to Vision (DANCE-OFF.md §3 face assignment),
  /// so the caller can pair the faces in it with that frame's poses: the result carries the
  /// frame's `ts` (the same value as its onPoses `ts`). `completion` runs on the snapshot queue
  /// with `{ok, uri, width, height, ts}` or `{ok: false, message}`. The caller deletes the file
  /// (it is also pruned with the other caches after a day).
  func captureStill(completion: @escaping (Payload) -> Void) {
    captureQueue.async { [weak self] in
      guard let self else {
        completion(["ok": false, "message": "camera view is gone"])
        return
      }
      let fresh = ProcessInfo.processInfo.systemUptime - self.lastFrameUptime
      guard self.lastFrameUptime > 0, fresh < DancePoseEngine.frameStaleAfter else {
        completion(["ok": false, "message": "camera is not running"])
        return
      }
      self.stillRequests.append(completion)
    }
  }

  /// Ends the round: finishes the clip, hashes it, and collects the snapshots. `completion` runs
  /// on a background queue with the stopRound result. Without a round it returns an empty result.
  func stopRound(completion: @escaping (Payload) -> Void) {
    captureQueue.async { [weak self] in
      guard let self, let finished = self.round else {
        completion(DancePoseEngine.emptyStopResult())
        return
      }
      self.round = nil

      let group = DispatchGroup()
      let box = StopResultBox()

      // Queued behind every JPEG this round enqueued, and before anything a later round enqueues.
      group.enter()
      self.snapshotQueue.async { [weak self] in
        box.snapshots = self?.snapshotsByRound.removeValue(forKey: finished.id) ?? []
        group.leave()
      }

      if let writer = finished.writer, let input = finished.input, let url = finished.clipURL,
        writer.status == .writing, !finished.writerFailed
      {
        group.enter()
        input.markAsFinished()
        writer.finishWriting {
          if writer.status == .completed {
            box.clipURL = url
          } else {
            try? FileManager.default.removeItem(at: url)
          }
          group.leave()
        }
      } else {
        DancePoseEngine.cancel(writer: finished.writer, clipURL: finished.clipURL)
      }

      group.notify(queue: DispatchQueue.global(qos: .userInitiated)) { [weak self] in
        var clipUri: Any = NSNull()
        var clipSha256: Any = NSNull()
        if let url = box.clipURL {
          if let sha = try? DancePoseFiles.sha256Hex(ofFileAt: url) {
            clipUri = url.absoluteString
            clipSha256 = sha
          } else {
            self?.emitStatus("error", "Could not read the recording")
          }
        }
        completion([
          "clipUri": clipUri,
          "clipSha256": clipSha256,
          "snapshots": box.snapshots.map { $0.dictionary },
        ])
        if self?.wantsRunning.get() == true {
          self?.emitStatus("running")
        }
      }
    }
  }

  /// Stops everything for good (the view is being deallocated).
  func shutdown() {
    wantsRunning.set(false)
    captureQueue.async { [self] in
      if let current = round {
        discard(current)
      }
      round = nil
    }
    sessionQueue.async { [self] in
      if session.isRunning {
        session.stopRunning()
      }
      videoOutput.setSampleBufferDelegate(nil, queue: nil)
    }
  }

  static func emptyStopResult() -> Payload {
    return ["clipUri": NSNull(), "clipSha256": NSNull(), "snapshots": [Any]()]
  }

  // MARK: - Session (sessionQueue)

  private func applyRunningState() {
    guard wantsRunning.get() else {
      if session.isRunning {
        session.stopRunning()
      }
      return
    }
    if session.isRunning {
      return
    }

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      break
    case .notDetermined:
      emitStatus("starting")
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        guard let self else {
          return
        }
        if granted {
          self.sessionQueue.async { [weak self] in
            self?.applyRunningState()
          }
        } else {
          self.emitStatus("no_camera", "Camera access is off")
        }
      }
      return
    case .denied, .restricted:
      emitStatus("no_camera", "Camera access is off")
      return
    @unknown default:
      emitStatus("no_camera", "Camera access is off")
      return
    }

    emitStatus("starting")
    guard configureIfNeeded() else {
      return
    }
    installObserversIfNeeded()
    session.startRunning()
    if session.isRunning {
      emitStatus("running")
      DispatchQueue.main.async { [weak self] in
        self?.runningHandler?()
      }
    } else {
      emitStatus("error", "Camera did not start")
    }
  }

  /// Back wide-angle camera, 1280x720, a video data output whose connection is rotated to
  /// portrait so every buffer arrives upright (720x1280) and Vision runs with orientation .up.
  private func configureIfNeeded() -> Bool {
    if configured {
      return true
    }
    if configurationFailed {
      emitStatus("no_camera", "No back camera")
      return false
    }
    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
    else {
      // The simulator has no camera.
      configurationFailed = true
      emitStatus("no_camera", "No back camera")
      return false
    }
    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: device)
    } catch {
      emitStatus("error", "Camera unavailable: \(error.localizedDescription)")
      return false
    }

    session.beginConfiguration()
    // No audio input: never let the session take over the app's audio (music, the voice judge).
    session.automaticallyConfiguresApplicationAudioSession = false
    if session.canSetSessionPreset(.hd1280x720) {
      session.sessionPreset = .hd1280x720
    }
    guard session.canAddInput(input) else {
      session.commitConfiguration()
      emitStatus("error", "Camera input rejected")
      return false
    }
    session.addInput(input)

    let preferred = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    let pixelFormat =
      videoOutput.availableVideoPixelFormatTypes.contains(preferred)
      ? preferred : kCVPixelFormatType_32BGRA
    videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: pixelFormat]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(self, queue: captureQueue)
    guard session.canAddOutput(videoOutput) else {
      session.removeInput(input)
      session.commitConfiguration()
      emitStatus("error", "Camera output rejected")
      return false
    }
    session.addOutput(videoOutput)
    if let connection = videoOutput.connection(with: .video) {
      DancePoseEngine.orientPortrait(connection)
      if connection.isVideoMirroringSupported {
        connection.automaticallyAdjustsVideoMirroring = false
        connection.isVideoMirrored = false
      }
    }
    session.commitConfiguration()

    DancePoseEngine.lockFrameRate(device, fps: 30)
    configured = true
    return true
  }

  static func orientPortrait(_ connection: AVCaptureConnection) {
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(90) {
        connection.videoRotationAngle = 90
      }
    } else {
      if connection.isVideoOrientationSupported {
        connection.videoOrientation = .portrait
      }
    }
  }

  private static func lockFrameRate(_ device: AVCaptureDevice, fps: Int32) {
    let wanted = Double(fps)
    let supported = device.activeFormat.videoSupportedFrameRateRanges.contains {
      $0.minFrameRate <= wanted && wanted <= $0.maxFrameRate
    }
    guard supported else {
      return
    }
    do {
      try device.lockForConfiguration()
      device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: fps)
      device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: fps)
      device.unlockForConfiguration()
    } catch {
      // Keep the preset's default rate.
    }
  }

  private func installObserversIfNeeded() {
    guard observerTokens.isEmpty else {
      return
    }
    let center = NotificationCenter.default
    observerTokens.append(
      center.addObserver(
        forName: AVCaptureSession.runtimeErrorNotification,
        object: session,
        queue: nil
      ) { [weak self] note in
        guard let self else {
          return
        }
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? AVError
        self.emitStatus("error", error?.localizedDescription ?? "Camera error")
        if error?.code == .mediaServicesWereReset {
          self.sessionQueue.async { [weak self] in
            self?.applyRunningState()
          }
        }
      })
    observerTokens.append(
      center.addObserver(
        forName: AVCaptureSession.wasInterruptedNotification,
        object: session,
        queue: nil
      ) { [weak self] _ in
        self?.emitStatus("error", "Camera interrupted")
      })
    observerTokens.append(
      center.addObserver(
        forName: AVCaptureSession.interruptionEndedNotification,
        object: session,
        queue: nil
      ) { [weak self] _ in
        guard let self else {
          return
        }
        self.sessionQueue.async { [weak self] in
          guard let self else {
            return
          }
          if self.session.isRunning {
            self.emitStatus("running")
          } else {
            self.applyRunningState()
          }
        }
      })
  }

  // MARK: - Frames (captureQueue)

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard pts.isValid else {
      return
    }
    lastFrameUptime = ProcessInfo.processInfo.systemUptime
    let start: CMTime
    if let existing = sessionStartPTS {
      start = existing
    } else {
      sessionStartPTS = pts
      start = pts
    }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)

    // 1. The round: t0, recording, snapshots. Every frame is recorded, throttled or not.
    let sessionT = DancePoseEngine.ms(from: start, to: pts)
    var t = sessionT
    if var current = round {
      let t0: CMTime
      if let existing = current.t0 {
        t0 = existing
      } else {
        t0 = pts
        current.t0 = pts
        startWriter(&current, width: width, height: height, at: pts)
      }
      t = DancePoseEngine.ms(from: t0, to: pts)
      append(sampleBuffer, to: &current)
      while current.nextSnapshot < current.snapshotTargets.count,
        t >= current.snapshotTargets[current.nextSnapshot]
      {
        enqueueSnapshot(pixelBuffer, tMs: t.rounded(), roundId: current.id, index: current.nextSnapshot)
        current.nextSnapshot += 1
      }
      round = current
    }

    // 2. Pose: drop the frame while Vision is busy or faster than maxFps.
    let minInterval = 1.0 / maxFps.get()
    var instantFps: Double?
    if let last = lastPoseDispatchPTS {
      let dt = CMTimeGetSeconds(CMTimeSubtract(pts, last))
      // 0.8: a 30 fps camera with maxFps 30 keeps every frame despite timestamp jitter.
      if dt > 0 && dt < minInterval * 0.8 {
        return
      }
      if dt > 0 {
        instantFps = 1 / dt
      }
    }
    if visionBusy.get() {
      return
    }
    visionBusy.set(true)
    lastPoseDispatchPTS = pts
    if let instantFps {
      fpsEMA = fpsEMA == 0 ? instantFps : fpsEMA * 0.9 + instantFps * 0.1
    }

    let frameT = (t * 10).rounded() / 10
    let frameTs = (sessionT * 10).rounded() / 10
    let fps = (fpsEMA * 10).rounded() / 10
    if !stillRequests.isEmpty {
      let waiting = stillRequests
      stillRequests = []
      enqueueStill(pixelBuffer, ts: frameTs, completions: waiting)
    }
    visionQueue.async { [weak self] in
      self?.detectPoses(pixelBuffer, t: frameT, ts: frameTs, width: width, height: height, fps: fps)
    }
  }

  private func startWriter(_ current: inout RoundState, width: Int, height: Int, at pts: CMTime) {
    do {
      let url = try DancePoseFiles.directory()
        .appendingPathComponent("round-\(current.id).mp4")
      try? FileManager.default.removeItem(at: url)
      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let compression: [String: Any] = [
        AVVideoAverageBitRateKey: 5_000_000,
        AVVideoExpectedSourceFrameRateKey: 30,
        AVVideoMaxKeyFrameIntervalKey: 30,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      ]
      let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: compression,
      ]
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
      input.expectsMediaDataInRealTime = true
      guard writer.canAdd(input) else {
        throw DancePoseError("writer rejected the video input")
      }
      writer.add(input)
      guard writer.startWriting() else {
        throw DancePoseError(writer.error?.localizedDescription ?? "writer did not start")
      }
      writer.startSession(atSourceTime: pts)
      current.writer = writer
      current.input = input
      current.clipURL = url
      emitStatus("recording")
    } catch {
      // The round still runs: poses and snapshots keep the same clock, the clip comes back null.
      current.writerFailed = true
      emitStatus("error", "Recording failed: \(error.localizedDescription)")
    }
  }

  private func append(_ sampleBuffer: CMSampleBuffer, to current: inout RoundState) {
    guard !current.writerFailed, let writer = current.writer, let input = current.input else {
      return
    }
    guard writer.status == .writing else {
      current.writerFailed = true
      emitStatus("error", "Recording failed: \(writer.error?.localizedDescription ?? "writer stopped")")
      return
    }
    // Real-time input: when the encoder is behind, drop this frame rather than block capture.
    if input.isReadyForMoreMediaData && !input.append(sampleBuffer) {
      current.writerFailed = true
      emitStatus("error", "Recording failed: \(writer.error?.localizedDescription ?? "append failed")")
    }
  }

  private func enqueueSnapshot(_ pixelBuffer: CVPixelBuffer, tMs: Double, roundId: String, index: Int) {
    snapshotQueue.async { [weak self] in
      guard let self else {
        return
      }
      do {
        let url = try DancePoseFiles.directory()
          .appendingPathComponent("snap-\(roundId)-\(index).jpg")
        let file = try self.encoder.encode(pixelBuffer: pixelBuffer, tMs: tMs, to: url)
        self.snapshotsByRound[roundId, default: []].append(file)
      } catch {
        // A failed snapshot is simply missing from the list; the caller checks the count.
      }
    }
  }

  /// The face still of a pose frame, full size (snapshotQueue); every waiting caller gets it.
  private func enqueueStill(
    _ pixelBuffer: CVPixelBuffer,
    ts: Double,
    completions: [(Payload) -> Void]
  ) {
    snapshotQueue.async { [weak self] in
      var result: Payload
      if let self {
        do {
          let url = try DancePoseFiles.directory()
            .appendingPathComponent("still-\(UUID().uuidString.lowercased()).jpg")
          let file = try self.stillEncoder.encode(pixelBuffer: pixelBuffer, tMs: ts, to: url)
          result = [
            "ok": true,
            "uri": file.uri,
            "width": file.width,
            "height": file.height,
            "ts": ts,
          ]
        } catch {
          result = ["ok": false, "message": error.localizedDescription]
        }
      } else {
        result = ["ok": false, "message": "camera view is gone"]
      }
      for completion in completions {
        completion(result)
      }
    }
  }

  /// Drops a round that was replaced or abandoned (captureQueue).
  private func discard(_ old: RoundState) {
    DancePoseEngine.cancel(writer: old.writer, clipURL: old.clipURL)
    let id = old.id
    snapshotQueue.async { [weak self] in
      let files = self?.snapshotsByRound.removeValue(forKey: id) ?? []
      for file in files {
        if let url = URL(string: file.uri) {
          try? FileManager.default.removeItem(at: url)
        }
      }
    }
  }

  private static func cancel(writer: AVAssetWriter?, clipURL: URL?) {
    if let writer, writer.status == .writing {
      writer.cancelWriting()
    }
    if let clipURL {
      try? FileManager.default.removeItem(at: clipURL)
    }
  }

  private static func ms(from start: CMTime, to time: CMTime) -> Double {
    let seconds = CMTimeGetSeconds(CMTimeSubtract(time, start))
    return seconds.isFinite ? seconds * 1000 : 0
  }

  // MARK: - Vision (visionQueue)

  private func detectPoses(
    _ pixelBuffer: CVPixelBuffer,
    t: Double,
    ts: Double,
    width: Int,
    height: Int,
    fps: Double
  ) {
    defer {
      visionBusy.set(false)
    }
    // The buffer is already upright (the connection rotates it), so no orientation hint.
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
    let observations: [VNHumanBodyPoseObservation]
    do {
      try handler.perform([poseRequest])
      observations = poseRequest.results ?? []
    } catch {
      // Skip the frame: reporting "nobody" for a failed request would look like an empty stage.
      return
    }
    let people: [[String: Any]] = observations.prefix(PoseExtraction.maxPeople).map {
      ["k": PoseExtraction.keypoints(of: $0)]
    }
    let payload: Payload = [
      "t": t,
      "ts": ts,
      "w": width,
      "h": height,
      "fps": fps,
      "people": people,
    ]
    DispatchQueue.main.async { [weak self] in
      self?.posesHandler?(payload)
    }
  }

  // MARK: - Status (any queue)

  private func emitStatus(_ state: String, _ message: String? = nil) {
    var payload: Payload = ["state": state]
    if let message {
      payload["message"] = message
    }
    DispatchQueue.main.async { [weak self] in
      self?.statusHandler?(payload)
    }
  }
}
