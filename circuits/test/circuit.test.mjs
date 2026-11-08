// End-to-end circuit tests: witness generation, Groth16 prove + verify with snarkjs,
// cross-checked against the poseidon-lite commitment. Requires `npm run setup` first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { poseidon8 } from "poseidon-lite";
import {
  buildCircuitInput,
  computeCommitment,
  circuitMatch,
  expectedPublicSignals,
  packEmbedding,
  saltToField,
  maskedField,
  toField,
} from "../js/biometric.mjs";
import { prove, verify, loadVerificationKey, encodeGroth16Proof, encodePublicInputs, terminate, BN254_Q } from "../js/groth16.mjs";
import { WASM_PATH, ZKEY_PATH, VK_PATH, BUILD_DIR } from "../js/paths.mjs";
import { vkToRust } from "../scripts/vk-to-rust.ts";
import { rng, randomUnit, quantize, perturb, bytes } from "./fixtures.mjs";

for (const p of [WASM_PATH, ZKEY_PATH, VK_PATH]) {
  assert.ok(existsSync(p), `missing ${p}: run \`npm run setup\` (scripts/setup.sh) in circuits/ first`);
}

after(async () => {
  await terminate();
});

const r = rng(2026);
const enrolledF = randomUnit(192, r);
const ENROLLED = quantize(enrolledF);
const SALT = bytes(31, r);
const BET = bytes(32, r);
const EVIDENCE = bytes(32, r);
const MATCHING = quantize(perturb(enrolledF, 0.8, r)); // cos ≈ 0.8 ≥ τ = 0.5
const NON_MATCHING = quantize(randomUnit(192, r)); // cos ≈ 0
const TAU_VOICE = 5000;

function input(overrides = {}) {
  return buildCircuitInput({
    enrolled: ENROLLED,
    salt: SALT,
    observed: MATCHING,
    betPubkey: BET,
    evidenceRoot: EVIDENCE,
    participantIdx: 1,
    frame: 41,
    modality: 1,
    tauBps: TAU_VOICE,
    ...overrides,
  });
}

async function witnessOk(inp) {
  const wtns = { type: "mem" };
  try {
    await snarkjs.wtns.calculate(inp, WASM_PATH, wtns);
    return true;
  } catch {
    return false;
  }
}

test("fixtures: matching case satisfies circuitMatch, non-matching does not", () => {
  assert.equal(circuitMatch(ENROLLED, MATCHING, TAU_VOICE), true);
  assert.equal(circuitMatch(ENROLLED, NON_MATCHING, TAU_VOICE), false);
});

test("matching case: proves result = 1 and verifies; public signals in contract order", async () => {
  const inp = input();
  assert.equal(inp.result, "1");
  const { proof, publicSignals } = await prove(inp);
  assert.deepEqual(publicSignals, expectedPublicSignals(inp));
  // Commitment cross-check: public signal 0 == poseidon-lite poseidon8(F_0..F_6, salt).
  assert.equal(BigInt(publicSignals[0]), poseidon8([...packEmbedding(ENROLLED), saltToField(SALT)]));
  assert.equal(BigInt(publicSignals[1]), maskedField(BET));
  assert.equal(BigInt(publicSignals[2]), maskedField(EVIDENCE));
  assert.equal(await verify(publicSignals, proof), true);

  // Tampering with any public signal must break verification.
  for (let i = 0; i < 8; i++) {
    const bad = [...publicSignals];
    bad[i] = (BigInt(bad[i]) + 1n).toString();
    assert.equal(await verify(bad, proof), false, `tampered public signal ${i} verified`);
  }

  // groth16-solana encodings are well-formed.
  const enc = encodeGroth16Proof(proof);
  assert.equal(enc.a.length, 64);
  assert.equal(enc.b.length, 128);
  assert.equal(enc.c.length, 64);
  const ay = BigInt("0x" + Buffer.from(enc.a.slice(32)).toString("hex"));
  assert.equal((ay + BigInt(proof.pi_a[1])) % BN254_Q, 0n, "proof_a.y is negated");
  const pubs = encodePublicInputs(publicSignals);
  assert.equal(pubs.length, 8);
  assert.equal(pubs[7][31], 1);
});

test("non-matching case: only result = 0 is provable; it verifies with result = 0", async () => {
  const inp = input({ observed: NON_MATCHING });
  assert.equal(inp.result, "0");
  const { proof, publicSignals } = await prove(inp);
  assert.equal(publicSignals[7], "0");
  assert.equal(await verify(publicSignals, proof), true);
  // The onchain verifier pins result = 1: this proof must not verify for it.
  const claimed = [...publicSignals];
  claimed[7] = "1";
  assert.equal(await verify(claimed, proof), false);
  // A prover cannot produce a witness claiming result = 1 for a non-match.
  assert.equal(await witnessOk({ ...inp, result: "1" }), false);
  await assert.rejects(prove({ ...inp, result: "1" }));
});

test("face modality: 128-d embeddings zero-padded to 192 prove and verify", async () => {
  const fr = rng(128);
  const face = randomUnit(128, fr);
  const enrolled = quantize(face);
  const observed = quantize(perturb(face, 0.75, fr));
  const salt = bytes(31, fr);
  assert.equal(circuitMatch(enrolled, observed, 5500), true);
  const inp = input({ enrolled, observed, salt, modality: 0, tauBps: 5500, participantIdx: 0, frame: 7 });
  const { proof, publicSignals } = await prove(inp);
  assert.equal(BigInt(publicSignals[0]), computeCommitment(enrolled, salt));
  assert.equal(publicSignals[7], "1");
  assert.equal(await verify(publicSignals, proof), true);
});

test("witness rejects a wrong commitment, wrong salt, and out-of-range values", async () => {
  const good = input();
  assert.equal(await witnessOk(good), true);
  assert.equal(await witnessOk({ ...good, commitment: (BigInt(good.commitment) + 1n).toString() }), false);
  assert.equal(await witnessOk({ ...good, salt: (BigInt(good.salt) ^ 1n).toString() }), false);
  // Claiming result = 0 for a real match is also unsatisfiable.
  assert.equal(await witnessOk({ ...good, result: "0" }), false);

  // observed_i = -128 (u = 0) and 128 (u = 256) are rejected.
  for (const v of [-128, 128, 1000]) {
    const obs = [...good.observed];
    obs[5] = toField(v).toString();
    assert.equal(await witnessOk({ ...good, observed: obs }), false, `observed ${v} accepted`);
  }
  // enrolled_i = 128 rejected even if the commitment is recomputed over the bogus value
  // (u = 256 would alias into the next byte of the packing).
  const enr = [...ENROLLED];
  enr[0] = 128;
  const u = enr.map((v) => BigInt(v + 128));
  const F = [];
  for (let k = 0; k < 7; k++) {
    let acc = 0n;
    for (let j = 0; j < 31 && 31 * k + j < 192; j++) acc += u[31 * k + j] << BigInt(8 * j);
    F.push(acc);
  }
  const bogusCommit = poseidon8([...F, saltToField(SALT)]);
  assert.equal(
    await witnessOk({ ...good, enrolled: enr.map((v) => toField(v).toString()), commitment: bogusCommit.toString() }),
    false,
  );
  // tau_bps >= 2^14 rejected.
  assert.equal(await witnessOk({ ...good, tau_bps: String(1 << 14) }), false);
});

test("threshold boundary matches circuitMatch exactly (τ just below / above the true cosine)", async () => {
  // Find the largest τ for which the match holds, then check τ and τ+1 in the circuit.
  let lo = 0;
  let hi = 10000;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (circuitMatch(ENROLLED, MATCHING, mid)) lo = mid;
    else hi = mid - 1;
  }
  const tauMax = lo;
  assert.ok(tauMax > 5000 && tauMax < 10000);
  assert.equal(await witnessOk(input({ tauBps: tauMax, result: "1" })), true);
  assert.equal(await witnessOk(input({ tauBps: tauMax + 1, result: "1" })), false);
  assert.equal(await witnessOk(input({ tauBps: tauMax + 1, result: "0" })), true);
});

test("committed vk.rs is in sync with verification_key.json", () => {
  const vk = loadVerificationKey();
  assert.equal(vk.nPublic, 8);
  assert.equal(vk.IC.length, 9);
  const rs = readFileSync(`${BUILD_DIR}/vk.rs`, "utf8");
  assert.equal(rs, vkToRust(vk));
  assert.match(rs, /vk_gamme_g2/);
  assert.match(rs, /nr_pubinputs: 8/);
});
