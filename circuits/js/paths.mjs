// Build artifact locations (produced by scripts/setup.sh).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CIRCUITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_DIR = resolve(CIRCUITS_DIR, "build");
export const WASM_PATH = resolve(BUILD_DIR, "biometric_match_js/biometric_match.wasm");
export const ZKEY_PATH = resolve(BUILD_DIR, "biometric_match_final.zkey");
export const VK_PATH = resolve(BUILD_DIR, "verification_key.json");
