import AVFoundation
import ExpoModulesCore
import UIKit

/// The Dance Off judge-cam view (DANCE-OFF.md §6.1): a live back-camera preview (aspect fit, so
/// the overlay coordinates map 1:1 onto the letterboxed image) plus the pose + recording engine.
/// All methods run on the main thread (props, view functions and UIKit callbacks).
public final class DancePoseView: ExpoView {
  // Event dispatchers: found by property name, so they must match Events(...) in the module.
  let onPoses = EventDispatcher()
  let onStatus = EventDispatcher()

  private let engine = DancePoseEngine()
  private let previewLayer = AVCaptureVideoPreviewLayer()
  private var active = false

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

  // MARK: - Private

  private func orientPreview() {
    guard let connection = previewLayer.connection else {
      return
    }
    DancePoseEngine.orientPortrait(connection)
  }
}
