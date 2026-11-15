#!/usr/bin/env node
// Usage: node scripts/verify.mjs [proof.json] [public.json] [verification_key.json]
// Exits 0 and prints "OK" iff the Groth16 proof verifies.
import { readFileSync } from "node:fs";
import { verify, loadVerificationKey, terminate } from "../js/groth16.mjs";
import { VK_PATH } from "../js/paths.mjs";

const [proofPath = "proof.json", publicPath = "public.json", vkPath = VK_PATH] = process.argv.slice(2);
try {
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  const publicSignals = JSON.parse(readFileSync(publicPath, "utf8"));
  const ok = await verify(publicSignals, proof, loadVerificationKey(vkPath));
  console.log(ok ? "OK" : "INVALID");
  process.exitCode = ok ? 0 : 1;
} finally {
  await terminate();
}
