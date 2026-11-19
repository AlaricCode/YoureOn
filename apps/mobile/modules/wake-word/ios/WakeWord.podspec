# Local Expo module (apps/mobile/modules/wake-word), autolinked from ./modules by
# expo-modules-autolinking (default nativeModulesDir). No package.json: the version lives here.
Pod::Spec.new do |s|
  s.name           = 'WakeWord'
  s.version        = '1.0.0'
  s.summary        = 'On-device "Jarvis" wake phrase listener (SFSpeechRecognizer + AVAudioEngine)'
  s.description    = 'An Expo module that streams microphone audio from AVAudioEngine into ' \
                     'SFSpeechAudioBufferRecognitionRequest, emits the rolling transcript to JS ' \
                     'and rotates recognition tasks before Apple\'s one-minute limit.'
  s.license        = 'MIT'
  s.author         = "You're On"
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'Speech', 'AVFoundation'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
