# circuits/ — Verdict biometric match (CONTRACTS.md §8.4, §8.6)

`biometric_match.circom` — `BiometricMatch(192)`, circom 2.1.9, Groth16/BN254, ~4.6K constraints.
Public signals (in order): `commitment, bet_field, evidence_field, participant_idx, frame, modality, tau_bps, result`.

```sh
npm install                 # snarkjs, circomlib, poseidon-lite, circom2 (circom 2.1.9 wasm)
npm run setup               # scripts/setup.sh: compile + local ptau (2^14) + zkey, fixed dev beacon (~2 min)
npm test                    # reference + prove/verify tests (needs setup)
node scripts/prove.mjs input.json proof.json public.json
node scripts/verify.mjs proof.json public.json
node scripts/vk-to-rust.ts build/verification_key.json build/vk.rs
```

Committed: `build/verification_key.json`, `build/vk.rs` (copy to `programs/verdict/src/zk/vk.rs`).
Not committed: ptau, zkey, r1cs, wasm (regenerated deterministically by `setup.sh`).
This is a DEV trusted setup: the beacon is public, so anyone can forge proofs. See the README trusted-setup statement.

JS helpers: `js/biometric.mjs` (packing, Poseidon commitment via poseidon-lite, `circuitMatch`, `buildCircuitInput`),
`js/groth16.mjs` (prove/verify, groth16-solana byte encodings).
