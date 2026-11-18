// Metro bundles .tflite files as assets (metro.config.js adds the extension). Importing one gives
// the numeric asset id that expo-asset's Asset.fromModule() accepts.
declare module '*.tflite' {
  const assetId: number;
  export default assetId;
}

// Font files (Metro's default asset extensions include .ttf). expo-font's loadAsync / useFonts
// accept the numeric asset id.
declare module '*.ttf' {
  const assetId: number;
  export default assetId;
}
