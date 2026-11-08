#!/usr/bin/env node
// Usage: node scripts/prove.mjs <input.json> [proof.json] [public.json]
// <input.json> is a circuit input object (see js/biometric.mjs buildCircuitInput).
// Writes snarkjs proof/public files and prints the groth16-solana encodings (hex).
import { readFileSync, writeFileSync } from "node:fs";
import { prove, encodeGroth16Proof, encodePublicInputs, terminate } from "../js/groth16.mjs";

const [inputPath, proofPath = "proof.json", publicPath = "public.json"] = process.argv.slice(2);
if (!inputPath) {
  console.error("usage: node scripts/prove.mjs <input.json> [proof.json] [public.json]");
  process.exit(2);
}

const hex = (b) => Buffer.from(b).toString("hex");
try {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const { proof, publicSignals } = await prove(input);
  writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  writeFileSync(publicPath, JSON.stringify(publicSignals, null, 2));
  const enc = encodeGroth16Proof(proof);
  console.log(
    JSON.stringify(
      {
        proof: proofPath,
        public: publicPath,
        public_signals: publicSignals,
        solana: {
          proof_a: hex(enc.a),
          proof_b: hex(enc.b),
          proof_c: hex(enc.c),
          public_inputs: encodePublicInputs(publicSignals).map(hex),
        },
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error(`prove failed: ${err.message ?? err}`);
  process.exitCode = 1;
} finally {
  await terminate();
}
