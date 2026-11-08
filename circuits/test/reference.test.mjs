// Off-circuit reference checks (no build artifacts needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { poseidon8 } from "poseidon-lite";
import {
  BN254_R,
  packEmbedding,
  computeCommitment,
  commitmentBytes,
  maskedField,
  circuitMatch,
  dotStats,
  toField,
  padEmbedding,
  buildCircuitInput,
  expectedPublicSignals,
  saltToField,
} from "../js/biometric.mjs";
import { rng, randomUnit, quantize, perturb, bytes } from "./fixtures.mjs";

test("packing of the all-zero embedding: every byte is 128", () => {
  const f = packEmbedding(new Array(192).fill(0));
  assert.equal(f.length, 7);
  let full = 0n;
  for (let j = 0; j < 31; j++) full += 128n << BigInt(8 * j);
  for (let k = 0; k < 6; k++) assert.equal(f[k], full);
  let last = 0n;
  for (let j = 0; j < 6; j++) last += 128n << BigInt(8 * j);
  assert.equal(f[6], last);
});

test("packing is little-endian with u = q + 128 and respects the 31-byte chunking", () => {
  const q = new Array(192).fill(0);
  q[0] = -127; // u = 1  -> F_0 low byte
  q[30] = 127; // u = 255 -> F_0 top byte (256^30)
  q[31] = -1; // u = 127 -> F_1 low byte
  q[191] = 5; // u = 133 -> F_6 byte 5
  const f = packEmbedding(q);
  assert.equal(f[0] & 0xffn, 1n);
  assert.equal((f[0] >> 240n) & 0xffn, 255n);
  assert.equal(f[1] & 0xffn, 127n);
  assert.equal((f[6] >> 40n) & 0xffn, 133n);
  for (const x of f) assert.ok(x < BN254_R);
});

test("commitment = poseidon-lite poseidon8(F_0..F_6, salt), salt little-endian", () => {
  const r = rng(7);
  const q = quantize(randomUnit(192, r));
  const salt = bytes(31, r);
  let saltLE = 0n;
  for (let i = 30; i >= 0; i--) saltLE = (saltLE << 8n) | BigInt(salt[i]);
  assert.equal(saltToField(salt), saltLE);
  assert.equal(computeCommitment(q, salt), poseidon8([...packEmbedding(q), saltLE]));
  const be = commitmentBytes(q, salt);
  assert.equal(be.length, 32);
  assert.equal(BigInt("0x" + Buffer.from(be).toString("hex")), computeCommitment(q, salt));
});

test("face embeddings are zero-padded to 192 before commitment", () => {
  const r = rng(9);
  const face = quantize(randomUnit(128, r));
  const salt = bytes(31, r);
  assert.equal(computeCommitment(face, salt), computeCommitment([...face, ...new Array(64).fill(0)], salt));
  assert.throws(() => padEmbedding(new Array(193).fill(0)));
  assert.throws(() => padEmbedding([128]));
  assert.throws(() => padEmbedding([-128]));
});

test("maskedField zeroes the first byte and reads big-endian", () => {
  const b = new Uint8Array(32).fill(0xff);
  const v = maskedField(b);
  assert.equal(v, (1n << 248n) - 1n);
  assert.ok(v < BN254_R);
  const c = new Uint8Array(32);
  c[31] = 1;
  c[1] = 2;
  assert.equal(maskedField(c), (2n << 240n) + 1n);
});

test("signed values map to r - |x|", () => {
  assert.equal(toField(-1), BN254_R - 1n);
  assert.equal(toField(5), 5n);
});

test("circuitMatch follows dot > 0 && dot²·1e8 >= τ²·ne·no", () => {
  const r = rng(3);
  const e = randomUnit(192, r);
  const qe = quantize(e);
  const close = quantize(perturb(e, 0.9, r));
  const far = quantize(randomUnit(192, r));
  assert.equal(circuitMatch(qe, close, 5000), true);
  assert.equal(circuitMatch(qe, far, 5000), false);
  assert.equal(circuitMatch(qe, qe.map((v) => -v), 0), false, "dot < 0 never matches, even at τ = 0");
  assert.equal(circuitMatch(qe, new Array(192).fill(0), 0), false, "dot = 0 never matches");
  // Boundary: identical vectors have cos = 1 -> match for τ = 10000 exactly.
  assert.equal(circuitMatch(qe, qe, 10000), true);
  const { dot, ne, no } = dotStats(qe, qe);
  assert.equal(dot, ne);
  assert.equal(ne, no);
});

test("buildCircuitInput emits public signals in contract order", () => {
  const r = rng(11);
  const q = quantize(randomUnit(192, r));
  const input = buildCircuitInput({
    enrolled: q,
    salt: bytes(31, r),
    observed: q,
    betPubkey: bytes(32, r),
    evidenceRoot: bytes(32, r),
    participantIdx: 3,
    frame: 41,
    modality: 1,
    tauBps: 5000,
  });
  const pub = expectedPublicSignals(input);
  assert.equal(pub.length, 8);
  assert.deepEqual(pub.slice(3), ["3", "41", "1", "5000", "1"]);
  assert.equal(input.enrolled.length, 192);
  assert.throws(() => buildCircuitInput({ ...input, participantIdx: 8 }));
});
