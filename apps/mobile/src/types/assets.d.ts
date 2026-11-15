// Metro bundles .tflite files as assets (metro.config.js adds the extension). Importing one gives
// the numeric asset id that expo-asset's Asset.fromModule() accepts.
declare module '*.tflite' {
  const assetId: number;
  export default assetId;
}
