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
