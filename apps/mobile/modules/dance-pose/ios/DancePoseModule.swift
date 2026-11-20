import AVFoundation
import ExpoModulesCore

/// startRound options (DANCE-OFF.md §6.1): ms since the round's first frame at which to keep a
/// JPEG snapshot.
struct StartRoundOptions: Record {
  @Field var snapshotAtMs: [Double] = []
}

/// The DancePose module: one native view, `DancePoseView`. JS loads it with
/// `requireNativeView('DancePose')` (the default view of the module) and checks for it with
/// `requireOptionalNativeModule('DancePose')`.
public final class DancePoseModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DancePose")

    // The real length of a recorded media file, read from the file itself (ms); -1 when it cannot
    // be read. The judge-cam clip's length was being estimated from timers around the recording,
    // and on a real device the estimate came out at 1.1 s for a clip several seconds long, so
    // the judge was only shown its first second.
    AsyncFunction("mediaDurationMs") { (uri: String) -> Double in
      let url = URL(string: uri).flatMap { $0.isFileURL ? $0 : nil } ?? URL(fileURLWithPath: uri)
      let seconds = CMTimeGetSeconds(AVURLAsset(url: url).duration)
      return seconds.isFinite && seconds > 0 ? seconds * 1000 : -1
    }

    View(DancePoseView.self) {
      Events("onPoses", "onStatus")

      Prop("active") { (view: DancePoseView, active: Bool?) in
        view.setActive(active ?? false)
      }

      Prop("maxFps") { (view: DancePoseView, maxFps: Double?) in
        view.setMaxFps(maxFps ?? DancePoseEngine.defaultMaxFps)
      }

      Prop("facing") { (view: DancePoseView, facing: String?) in
        view.setFacing(facing)
      }

      AsyncFunction("startRound") { (view: DancePoseView, options: StartRoundOptions, promise: Promise) in
        view.startRound(options, promise: promise)
      }

      AsyncFunction("stopRound") { (view: DancePoseView, promise: Promise) in
        view.stopRound(promise: promise)
      }

      AsyncFunction("captureStill") { (view: DancePoseView, promise: Promise) in
        view.captureStill(promise: promise)
      }
    }
  }
}
