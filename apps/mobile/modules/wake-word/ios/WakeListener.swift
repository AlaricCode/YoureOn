import AVFoundation
import Foundation
import Speech

/// One listening session's options, already defaulted by `WakeWordModule`.
struct WakeListenerOptions {
  var locale: String
  var contextualStrings: [String]
  var onDevice: Bool
}

/// Listens for the wake phrase: microphone audio from an `AVAudioEngine` input tap is streamed into
/// an `SFSpeechAudioBufferRecognitionRequest`, and every partial transcription goes to JS, which
/// decides when "Jarvis, <challenge>" has been said and calls `stop()`.
///
/// Recognition tasks are rotated (a fresh request + task, `segment` + 1) when a task ends on its
/// own (final result or error), after `taskMaxSeconds` (Apple stops a task at about one minute),
/// and when the transcript grows past `longTranscriptChars` without the wake word in it. The audio
/// engine and its tap keep running across rotations; only a route change, an engine configuration
/// change or an interruption rebuilds them.
///
/// Threading: every stored property except `liveRequest` is confined to `queue`. Speech result
/// callbacks (delivered on the recognizer's queue, main by default) and notification observers
/// hop onto `queue` before touching state. The audio tap runs on the render thread and only reads
/// `liveRequest`, under `liveLock`.
final class WakeListener {
  typealias Emit = (_ eventName: String, _ body: [String: Any?]) -> Void

  /// Rotate a task before Apple's ~1 minute cap on a single recognition task.
  static let taskMaxSeconds: Double = 50
  /// Once the wake word is in the transcript, the time-limit rotation waits this much longer, once,
  /// so it does not cut "Jarvis, <challenge>" in half.
  static let wakeGraceSeconds: Double = 8
  /// Rotate when the transcript of the current task gets this long without the wake word.
  static let longTranscriptChars = 200
  /// Hard cap on a task's transcript even when the wake word was heard.
  static let longTranscriptWithWakeChars = 1000
  /// Recognition errors in a row (without any transcript in between) before giving up.
  static let maxConsecutiveFailures = 6
  /// Audio rebuild attempts (interruption ended, route change) before giving up.
  static let maxRebuildAttempts = 3

  private static let benignSpeechErrorCodes: Set<Int> = [
    203, // "Retry" / no usable speech
    216, // request cancelled
    301, // recognition request was cancelled
    1101, // on-device: no speech recognised in the request
    1110, // no speech detected
  ]

  private let queue = DispatchQueue(label: "expo.modules.wakeword.listener", qos: .userInitiated)

  // MARK: - State confined to `queue`

  private var emit: Emit?
  private var wantsRunning = false
  private var interrupted = false
  private var options = WakeListenerOptions(locale: "en-US", contextualStrings: ["Jarvis"], onDevice: true)
  private var recognizer: SFSpeechRecognizer?
  private var onDeviceActive = false
  private var engine: AVAudioEngine?
  private var tapInstalled = false
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  /// Increments every time a recognition task starts; monotonic for the listener's lifetime.
  private var segment = 0
  /// The segment whose callbacks are still wanted (nil between a cancel and the next start).
  private var liveSegment: Int?
  private var taskStartedAt = Date()
  private var heardWake = false
  private var graceUsed = false
  private var consecutiveFailures = 0
  private var rotateWork: DispatchWorkItem?
  private var pendingStart: DispatchWorkItem?
  private var rebuildWork: DispatchWorkItem?
  private var observers: [NSObjectProtocol] = []
  private var sessionActivatedByUs = false
  private var savedSession: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

  // MARK: - Shared with the audio render thread

  private let liveLock = NSLock()
  private var liveRequest: SFSpeechAudioBufferRecognitionRequest?

  // MARK: - Public API (callable from any thread)

  func setEmitter(_ emit: Emit?) {
    queue.async {
      self.emit = emit
    }
  }

  /// Starts (or restarts with new options) listening. `completion` gets the JS start result.
  func start(_ opts: WakeListenerOptions, completion: @escaping ([String: Any]) -> Void) {
    queue.async {
      if self.wantsRunning || self.engine != nil || self.interrupted {
        // Already listening: rebuild with the new options, keeping the audio session active.
        self.teardown(deactivate: false)
      }
      completion(self.begin(opts))
    }
  }

  /// Stops listening. `completion` runs only once the task is cancelled, the tap removed, the engine
  /// stopped and the audio session deactivated (so another audio stack can take the microphone).
  func stop(completion: @escaping () -> Void) {
    queue.async {
      let wasActive = self.wantsRunning || self.engine != nil || self.sessionActivatedByUs
      self.teardown(deactivate: true)
      if wasActive {
        self.emitState("stopped")
      }
      completion()
    }
  }

  /// Module teardown (OnDestroy): release everything and stop emitting.
  func shutdown() {
    queue.async {
      self.teardown(deactivate: true)
      self.emit = nil
    }
  }

  // MARK: - Static helpers

  static func isRecognizerAvailable(locale: String) -> Bool {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
      return false
    }
    return recognizer.isAvailable
  }

  /// Asks for speech recognition, then microphone permission (each only when undetermined), and
  /// reports both statuses. Never prompts when the Info.plist usage string is missing (iOS would
  /// kill the app); that permission is reported as denied instead.
  static func requestPermissions(completion: @escaping ([String: String]) -> Void) {
    let hasSpeechUsage = hasUsageDescription("NSSpeechRecognitionUsageDescription")
    let hasMicUsage = hasUsageDescription("NSMicrophoneUsageDescription")

    let finish: () -> Void = {
      var speech = WakeListener.speechStatusString(SFSpeechRecognizer.authorizationStatus())
      var mic = WakeListener.micStatusString()
      if !hasSpeechUsage && speech == "undetermined" {
        NSLog("[WakeWord] NSSpeechRecognitionUsageDescription is missing from Info.plist")
        speech = "denied"
      }
      if !hasMicUsage && mic == "undetermined" {
        NSLog("[WakeWord] NSMicrophoneUsageDescription is missing from Info.plist")
        mic = "denied"
      }
      completion(["speech": speech, "mic": mic])
    }

    let askMic: () -> Void = {
      guard hasMicUsage, WakeListener.micStatusString() == "undetermined" else {
        finish()
        return
      }
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission(completionHandler: { _ in
          finish()
        })
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { _ in
          finish()
        }
      }
    }

    guard hasSpeechUsage, SFSpeechRecognizer.authorizationStatus() == .notDetermined else {
      askMic()
      return
    }
    SFSpeechRecognizer.requestAuthorization { _ in
      askMic()
    }
  }

  private static func hasUsageDescription(_ key: String) -> Bool {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
      return false
    }
    return !value.isEmpty
  }

  private static func speechStatusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized:
      return "granted"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    case .notDetermined:
      return "undetermined"
    @unknown default:
      return "undetermined"
    }
  }

  private static func micStatusString() -> String {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted:
        return "granted"
      case .denied:
        return "denied"
      case .undetermined:
        return "undetermined"
      @unknown default:
        return "undetermined"
      }
    } else {
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted:
        return "granted"
      case .denied:
        return "denied"
      case .undetermined:
        return "undetermined"
      @unknown default:
        return "undetermined"
      }
    }
  }

  /// `.mixWithOthers` rather than `.duckOthers`: the listener can run for minutes, and ducking other
  /// apps' audio for that long is worse than slightly noisier recognition.
  private static var categoryOptions: AVAudioSession.CategoryOptions {
    #if compiler(>=6.2) // Xcode 26 renamed .allowBluetooth
    return [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP]
    #else
    return [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]
    #endif
  }

  // MARK: - Session lifecycle (on `queue`)

  private func begin(_ opts: WakeListenerOptions) -> [String: Any] {
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
      return failure("speech-permission")
    }
    guard Self.micStatusString() == "granted" else {
      return failure("mic-permission")
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: opts.locale)) else {
      return failure("unsupported-locale")
    }
    guard recognizer.isAvailable else {
      return failure("recognizer-unavailable")
    }

    let onDevice = opts.onDevice && recognizer.supportsOnDeviceRecognition
    recognizer.defaultTaskHint = .dictation
    self.recognizer = recognizer
    self.options = opts
    self.onDeviceActive = onDevice

    do {
      try activateSession()
    } catch {
      teardown(deactivate: true)
      return failure("audio-session: \(error.localizedDescription)")
    }
    if let reason = startAudioPipeline() {
      teardown(deactivate: true)
      return failure(reason)
    }

    wantsRunning = true
    interrupted = false
    consecutiveFailures = 0
    addObservers()
    startTask()
    emitState("listening")
    return ["ok": true, "onDevice": onDevice]
  }

  /// A failed start. Also hands back an audio session a previous (replaced) start had activated.
  private func failure(_ reason: String) -> [String: Any] {
    deactivateSession()
    return ["ok": false, "onDevice": false, "reason": reason]
  }

  /// Gives up after an unrecoverable error: releases the microphone, then tells JS.
  private func fail(_ message: String) {
    teardown(deactivate: true)
    emitState("error", message)
  }

  private func teardown(deactivate: Bool) {
    wantsRunning = false
    interrupted = false
    pendingStart?.cancel()
    pendingStart = nil
    rebuildWork?.cancel()
    rebuildWork = nil
    cancelTask()
    stopAudioPipeline()
    removeObservers()
    recognizer = nil
    if deactivate {
      deactivateSession()
    }
  }

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    if savedSession == nil {
      savedSession = (
        category: session.category,
        mode: session.mode,
        options: session.categoryOptions
      )
    }
    try session.setCategory(.playAndRecord, mode: .default, options: Self.categoryOptions)
    try session.setActive(true)
    sessionActivatedByUs = true
  }

  private func deactivateSession() {
    let session = AVAudioSession.sharedInstance()
    var deactivated = true
    if sessionActivatedByUs {
      sessionActivatedByUs = false
      do {
        try session.setActive(false, options: .notifyOthersOnDeactivation)
      } catch {
        // Another part of the app still has audio I/O running; the session stays active for it.
        deactivated = false
        NSLog("[WakeWord] audio session deactivation failed: %@", error.localizedDescription)
      }
    }
    if let saved = savedSession {
      savedSession = nil
      // Never re-categorise a session someone else is still using (that would cut their audio).
      guard deactivated else {
        return
      }
      do {
        try session.setCategory(saved.category, mode: saved.mode, options: saved.options)
      } catch {
        NSLog("[WakeWord] restoring the audio session category failed: %@", error.localizedDescription)
      }
    }
  }

  // MARK: - Audio engine (on `queue`)

  /// Builds a fresh engine with an input tap and starts it. Returns a failure reason, or nil.
  private func startAudioPipeline() -> String? {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      return "no-audio-input"
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.appendLive(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      return "audio-engine: \(error.localizedDescription)"
    }
    self.engine = engine
    self.tapInstalled = true
    return nil
  }

  private func stopAudioPipeline() {
    guard let engine = engine else {
      return
    }
    engine.stop()
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    self.engine = nil
  }

  /// Render thread: hand the buffer to whichever request is live right now.
  private func appendLive(_ buffer: AVAudioPCMBuffer) {
    liveLock.lock()
    let request = liveRequest
    liveLock.unlock()
    request?.append(buffer)
  }

  private func setLiveRequest(_ request: SFSpeechAudioBufferRecognitionRequest?) {
    liveLock.lock()
    liveRequest = request
    liveLock.unlock()
  }

  // MARK: - Recognition tasks (on `queue`)

  private func startTask() {
    guard let recognizer = recognizer else {
      return
    }
    cancelTask()

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.contextualStrings = options.contextualStrings
    request.requiresOnDeviceRecognition = onDeviceActive

    segment += 1
    let seg = segment
    liveSegment = seg
    taskStartedAt = Date()
    heardWake = false
    graceUsed = false
    self.request = request
    setLiveRequest(request)

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      // Read the result here (the recognizer's queue), then hop onto ours.
      let text = result?.bestTranscription.formattedString
      let isFinal = result?.isFinal ?? false
      let nsError = error.map { $0 as NSError }
      guard let self = self else {
        return
      }
      self.queue.async {
        self.handleResult(segment: seg, text: text, isFinal: isFinal, error: nsError)
      }
    }
    scheduleRotation(after: Self.taskMaxSeconds, segment: seg)
  }

  private func cancelTask() {
    rotateWork?.cancel()
    rotateWork = nil
    liveSegment = nil
    setLiveRequest(nil)
    request?.endAudio()
    request = nil
    task?.cancel()
    task = nil
  }

  private func handleResult(segment seg: Int, text: String?, isFinal: Bool, error: NSError?) {
    guard wantsRunning, !interrupted, liveSegment == seg else {
      return
    }

    if let text = text {
      consecutiveFailures = 0
      if !heardWake && containsWakeWord(text) {
        heardWake = true
      }
      emit?("onTranscript", ["text": text, "isFinal": isFinal, "segment": seg])
      if isFinal {
        rotate(reason: "final result")
        return
      }
      let limit = heardWake ? Self.longTranscriptWithWakeChars : Self.longTranscriptChars
      if text.count > limit {
        rotate(reason: "long transcript")
        return
      }
    }

    guard let error = error else {
      return
    }
    let quick = Date().timeIntervalSince(taskStartedAt) < 1.0
    if isBenign(error) && !quick {
      rotate(reason: "task ended")
      return
    }
    consecutiveFailures += 1
    if consecutiveFailures >= Self.maxConsecutiveFailures {
      fail("recognition failed: \(error.localizedDescription)")
      return
    }
    rotate(reason: error.localizedDescription, delay: min(0.25 * Double(consecutiveFailures), 1.5))
  }

  private func isBenign(_ error: NSError) -> Bool {
    if error.domain == "kAFAssistantErrorDomain" {
      return Self.benignSpeechErrorCodes.contains(error.code)
    }
    if error.domain == "SFSpeechErrorDomain" {
      return error.code == 12 // SFSpeechErrorCodeTimeout
    }
    return false
  }

  private func containsWakeWord(_ text: String) -> Bool {
    for word in options.contextualStrings where !word.isEmpty {
      if text.range(of: word, options: [.caseInsensitive, .diacriticInsensitive]) != nil {
        return true
      }
    }
    return false
  }

  /// Replaces the current task with a fresh one (the engine and tap keep running).
  private func rotate(reason: String, delay: Double = 0) {
    guard wantsRunning, !interrupted else {
      return
    }
    cancelTask()
    pendingStart?.cancel()
    pendingStart = nil
    emitState("restarting", reason)

    guard delay > 0 else {
      startTask()
      emitState("listening")
      return
    }
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else {
        return
      }
      self.pendingStart = nil
      guard self.wantsRunning, !self.interrupted, self.engine != nil else {
        return
      }
      self.startTask()
      self.emitState("listening")
    }
    pendingStart = work
    queue.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func scheduleRotation(after seconds: Double, segment seg: Int) {
    rotateWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self, self.wantsRunning, self.liveSegment == seg else {
        return
      }
      if self.heardWake && !self.graceUsed {
        self.graceUsed = true
        self.scheduleRotation(after: Self.wakeGraceSeconds, segment: seg)
        return
      }
      self.rotate(reason: "time limit")
    }
    rotateWork = work
    queue.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  // MARK: - Interruptions and route changes (on `queue`)

  private func addObservers() {
    removeObservers()
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()

    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: session,
      queue: nil
    ) { [weak self] note in
      guard
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let kind = AVAudioSession.InterruptionType(rawValue: raw)
      else {
        return
      }
      self?.queue.async {
        self?.handleInterruption(kind)
      }
    })

    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: session,
      queue: nil
    ) { [weak self] note in
      guard
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
        let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
      else {
        return
      }
      // Only input-device changes matter; our own setCategory posts .categoryChange, ignored here.
      guard reason == .newDeviceAvailable || reason == .oldDeviceUnavailable else {
        return
      }
      self?.queue.async {
        // While interrupted the engine is down; the interruption's end rebuilds it.
        guard let self = self, !self.interrupted else {
          return
        }
        self.scheduleRebuild(reason: "audio route changed", reactivate: false)
      }
    })

    observers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        self?.scheduleRebuild(reason: "media services reset", reactivate: true)
      }
    })

    observers.append(center.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: nil,
      queue: nil
    ) { [weak self] note in
      let source = note.object.map { $0 as AnyObject }
      self?.queue.async {
        guard let self = self, let engine = self.engine, source === engine else {
          return
        }
        self.scheduleRebuild(reason: "audio configuration changed", reactivate: false)
      }
    })
  }

  private func removeObservers() {
    let center = NotificationCenter.default
    for observer in observers {
      center.removeObserver(observer)
    }
    observers.removeAll()
  }

  private func handleInterruption(_ type: AVAudioSession.InterruptionType) {
    switch type {
    case .began:
      guard wantsRunning, !interrupted else {
        return
      }
      interrupted = true
      pendingStart?.cancel()
      pendingStart = nil
      rebuildWork?.cancel()
      rebuildWork = nil
      cancelTask()
      stopAudioPipeline()
      emitState("interrupted", "audio session interrupted")
    case .ended:
      guard wantsRunning, interrupted else {
        return
      }
      scheduleRebuild(reason: "interruption ended", reactivate: true)
    @unknown default:
      break
    }
  }

  /// Debounced: tear the engine down and build a new one (the input format may have changed).
  private func scheduleRebuild(reason: String, reactivate: Bool, attempt: Int = 1) {
    guard wantsRunning else {
      return
    }
    rebuildWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else {
        return
      }
      self.rebuildWork = nil
      self.rebuild(reason: reason, reactivate: reactivate, attempt: attempt)
    }
    rebuildWork = work
    queue.asyncAfter(deadline: .now() + 0.4 * Double(attempt), execute: work)
  }

  private func rebuild(reason: String, reactivate: Bool, attempt: Int) {
    guard wantsRunning else {
      return
    }
    pendingStart?.cancel()
    pendingStart = nil
    cancelTask()
    stopAudioPipeline()
    emitState("restarting", reason)

    var failureReason: String?
    if reactivate {
      do {
        try activateSession()
      } catch {
        failureReason = "audio-session: \(error.localizedDescription)"
      }
    }
    if failureReason == nil {
      failureReason = startAudioPipeline()
    }

    if let failureReason = failureReason {
      if attempt < Self.maxRebuildAttempts {
        // Keep `interrupted` as it was so stray recognition callbacks stay ignored meanwhile.
        scheduleRebuild(reason: reason, reactivate: true, attempt: attempt + 1)
      } else {
        fail(failureReason)
      }
      return
    }

    interrupted = false
    startTask()
    emitState("listening")
  }

  // MARK: - Events

  private func emitState(_ state: String, _ message: String? = nil) {
    var body: [String: Any?] = ["state": state]
    if let message = message {
      body["message"] = message
    }
    emit?("onState", body)
  }
}
