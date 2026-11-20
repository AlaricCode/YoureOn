import AVFoundation
import ExpoModulesCore
import UIKit

/// The Dance Off judge-cam view (DANCE-OFF.md §6.1): a live camera preview (aspect fit, so
/// the overlay coordinates map 1:1 onto the letterboxed image) plus the pose + recording engine.
/// All methods run on the main thread (props, view functions and UIKit callbacks).
public final class DancePoseView: ExpoView {
  // Event dispatchers: found by property name, so they must match Events(...) in the module.
  let onPoses = EventDispatcher()
  let onStatus = EventDispatcher()

  private let engine = DancePoseEngine()
  private let previewLayer = AVCaptureVideoPreviewLayer()
  private var active = false
  /// AVCaptureDevice.RotationCoordinator (iOS 17+): the angles that keep the preview and the
  /// frames upright however the device is held. Kept as AnyObject for the older-OS build.
  private var rotationCoordinator: AnyObject?
  private var rotationObservations: [NSKeyValueObservation] = []

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black

    previewLayer.session = engine.session
    previewLayer.videoGravity = .resizeAspect
    layer.addSublayer(previewLayer)

    engine.posesHandler = { [weak self] payload in
      self?.onPoses(payload)
    }
    engine.statusHandler = { [weak self] payload in
      self?.onStatus(payload)
    }
    engine.runningHandler = { [weak self] in
      self?.orientPreview()
    }
  }

  deinit {
    rotationObservations.forEach { $0.invalidate() }
    // The engine outlives the view until its queues have stopped the session.
    engine.shutdown()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.frame = bounds
    CATransaction.commit()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    // Off screen (unmounted, or a screen pushed over it) the camera stops; back on screen it
    // resumes if the `active` prop still says so.
    engine.setActive(active && window != nil)
  }

  // MARK: - Props

  func setActive(_ value: Bool) {
    active = value
    engine.setActive(value && window != nil)
  }

  func setMaxFps(_ value: Double) {
    engine.setMaxFps(value)
  }

  /// "front": the selfie camera (its preview is a mirror image). Anything else: the back camera.
  func setFacing(_ value: String?) {
    engine.setFacing(front: value == "front")
  }

  // MARK: - View functions

  func startRound(_ options: StartRoundOptions, promise: Promise) {
    engine.startRound(snapshotAtMs: options.snapshotAtMs) { ok, message in
      var result: [String: Any] = ["ok": ok]
      if let message {
        result["message"] = message
      }
      promise.resolve(result)
    }
  }

  func stopRound(promise: Promise) {
    engine.stopRound { result in
      promise.resolve(result)
    }
  }

  func captureStill(promise: Promise) {
    engine.captureStill { result in
      promise.resolve(result)
    }
  }

  // MARK: - Private

  /// The preview and the frames follow how the device is held (portrait or on its side), through
  /// the system's rotation coordinator, which knows each camera's mounting. Before iOS 17 both
  /// stay portrait, as they always were.
  private func orientPreview() {
    guard let connection = previewLayer.connection else {
      return
    }
    guard #available(iOS 17.0, *), let device = engine.captureDevice.get() else {
      DancePoseEngine.orientPortrait(connection)
      return
    }
    rotationObservations.forEach { $0.invalidate() }
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
    rotationCoordinator = coordinator
    rotationObservations = [
      coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) {
        [weak self] coordinator, _ in
        let angle = coordinator.videoRotationAngleForHorizonLevelPreview
        DispatchQueue.main.async {
          guard let connection = self?.previewLayer.connection,
            connection.isVideoRotationAngleSupported(angle)
          else {
            return
          }
          connection.videoRotationAngle = angle
        }
      },
      coordinator.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.initial, .new]) {
        [weak self] coordinator, _ in
        self?.engine.setCaptureRotation(coordinator.videoRotationAngleForHorizonLevelCapture)
      },
    ]
  }
}
