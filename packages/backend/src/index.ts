/**
 * @verdict/backend public surface (for the demo script, tests and service modules).
 */
export * from './errors.js';
export * from './config/index.js';
export { buildApp, type BuildAppOptions } from './app.js';
export { createContext, consoleLogger, silentLogger, type AppContext, type AppHooks, type ContextOptions, type Logger } from './context.js';
export * from './chain/index.js';
export * from './providers/index.js';
export { AuthService, loginMessage, LOGIN_TAG, MOCK_EMAIL_CODE } from './auth/service.js';
export { TxService, type SignPayload, type SubmitResponse, type ConfirmHook } from './tx/service.js';
export { WsHub, WS_PATH, type WsConnection, type SnapshotProvider, type TopicKind } from './ws/hub.js';
export type { ServerMessage, ClientMessage, Topic } from './ws/messages.js';
export { Keeper, type KeeperTask } from './keeper/keeper.js';
export { JsonStore, Collection } from './persistence/store.js';
export { BlobStore } from './persistence/blobs.js';
export * from './persistence/records.js';
export { generateKeypair, keypairFromSecret, keypairFromSeed, verifyEd25519, type KeyPair } from './crypto/keys.js';
export { encryptAesGcm, decryptAesGcm } from './crypto/aes.js';
export { ManualClock, systemClock, type Clock } from './util/clock.js';
export { encodeWav, decodeWav, silentWav, beepWav } from './util/wav.js';
export * as bytes from './util/bytes.js';
export { ROUTE_MODULES, STUBS } from './routes/index.js';
