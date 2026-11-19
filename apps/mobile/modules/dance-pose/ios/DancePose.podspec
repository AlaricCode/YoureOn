# Local Expo module (apps/mobile/modules/dance-pose), autolinked from ./modules by
# expo-modules-autolinking (default nativeModulesDir). No package.json: the version lives here.
Pod::Spec.new do |s|
  s.name           = 'DancePose'
  s.version        = '1.0.0'
  s.summary        = 'Apple Vision body pose + same-clock recording for the Dance Off judge cam'
  s.description    = 'An Expo native view that runs an AVCaptureSession on the back camera, ' \
                     'detects human body pose with VNDetectHumanBodyPoseRequest per frame and ' \
                     'records the same sample buffers with AVAssetWriter.'
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

  s.frameworks = 'AVFoundation', 'Vision', 'CoreImage', 'CoreMedia', 'CoreVideo', 'ImageIO', 'CryptoKit'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
