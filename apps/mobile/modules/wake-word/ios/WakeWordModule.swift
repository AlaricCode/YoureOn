import ExpoModulesCore

/// start() options. Every field is optional (undefined or null keeps the default) so a partial or
/// sloppy options object never rejects the call.
struct WakeWordStartOptions: Record {
  @Field var locale: String?
  @Field var contextualStrings: [String]?
  @Field var onDevice: Bool?
}

/// The WakeWord module: an on-device "Jarvis" wake phrase listener (SFSpeechRecognizer fed by an
/// AVAudioEngine input tap). JS loads it with `requireOptionalNativeModule('WakeWord')`; see
/// ../index.ts for the typed binding and ../README.md for the contract.
public final class WakeWordModule: Module {
  static let defaultLocale = "en-US"
  static let defaultContextualStrings = ["Jarvis"]

  private let listener = WakeListener()

  public func definition() -> ModuleDefinition {
    Name("WakeWord")

    Events("onTranscript", "onState")

    OnCreate {
      self.listener.setEmitter { [weak self] eventName, body in
        self?.sendEvent(eventName, body)
      }
    }

    OnDestroy {
      self.listener.shutdown()
    }

    Function("isAvailable") { (locale: String?) -> Bool in
      return WakeListener.isRecognizerAvailable(locale: locale ?? WakeWordModule.defaultLocale)
    }

    AsyncFunction("requestPermissions") { (promise: Promise) in
      WakeListener.requestPermissions { statuses in
        promise.resolve(statuses)
      }
    }

    AsyncFunction("start") { (options: WakeWordStartOptions?, promise: Promise) in
      var locale = WakeWordModule.defaultLocale
      if let requested = options?.locale, !requested.isEmpty {
        locale = requested
      }
      let strings = (options?.contextualStrings ?? WakeWordModule.defaultContextualStrings)
        .filter { !$0.isEmpty }
      let opts = WakeListenerOptions(
        locale: locale,
        contextualStrings: strings.isEmpty ? WakeWordModule.defaultContextualStrings : strings,
        onDevice: options?.onDevice ?? true
      )
      self.listener.start(opts) { result in
        promise.resolve(result)
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.listener.stop {
        promise.resolve()
      }
    }
  }
}
