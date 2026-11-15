pragma circom 2.1.9;

// Verdict biometric match circuit — CONTRACTS.md §8.6.
//
// Proves knowledge of (enrolled, salt, observed) such that
//   * Poseidon commitment of (enrolled, salt) per §8.4 equals the public `commitment`;
//   * result = [dot > 0] · [dot²·10^8 >= tau_bps²·ne·no]  (fixed-point cosine >= tau, §8.3);
// and binds the proof to bet_field / evidence_field / participant_idx / frame / modality.
//
// Compile with: circom biometric_match.circom --r1cs --wasm --sym -l node_modules

include "lib/biometric_lib.circom";

template BiometricMatch(D) {
    // ---- public inputs (order fixed by the `main` declaration below) ----
    signal input commitment;
    signal input bet_field;
    signal input evidence_field;
    signal input participant_idx;
    signal input frame;
    signal input modality;
    signal input tau_bps;
    signal input result;

    // ---- private inputs ----
    signal input enrolled[D];   // signed i8 values in [-127, 127]; negatives as p - |x|
    signal input salt;          // 31 random bytes, little-endian
    signal input observed[D];   // signed i8 values in [-127, 127]

    // 1. Commitment opening (also range-checks enrolled_i + 128 to [1, 255]).
    component com = EmbeddingCommitment(D);
    for (var i = 0; i < D; i++) {
        com.q[i] <== enrolled[i];
    }
    com.salt <== salt;
    com.commit === commitment;

    // 2. Range-check observed_i + 128 to [1, 255].
    component obs[D];
    for (var i = 0; i < D; i++) {
        obs[i] = ShiftedByte();
        obs[i].q <== observed[i];
    }

    // 3. dot, ne, no.
    component ipDot = InnerProduct(D);
    component ipNe = InnerProduct(D);
    component ipNo = InnerProduct(D);
    for (var i = 0; i < D; i++) {
        ipDot.a[i] <== enrolled[i];
        ipDot.b[i] <== observed[i];
        ipNe.a[i] <== enrolled[i];
        ipNe.b[i] <== enrolled[i];
        ipNo.a[i] <== observed[i];
        ipNo.b[i] <== observed[i];
    }
    signal dot <== ipDot.out;
    signal ne <== ipNe.out;
    signal no <== ipNo.out;

    // |dot| <= D·127² < 2^22 (for D = 192): dot + 2^22 must fit in 23 bits.
    signal dotShifted <== dot + (1 << 22);
    component dotBits = Num2Bits(23);
    dotBits.in <== dotShifted;

    // 4. pos = dot > 0  <=>  dot + 2^22 > 2^22.
    component gt = GreaterThan(23);
    gt.in[0] <== dotShifted;
    gt.in[1] <== 1 << 22;
    signal pos <== gt.out;

    // 5. tau_bps < 2^14.
    component tauBits = Num2Bits(14);
    tauBits.in <== tau_bps;

    // 6. big = dot²·10^8 >= tau²·ne·no.
    signal dotSq <== dot * dot;
    signal tauSq <== tau_bps * tau_bps;
    signal neNo <== ne * no;
    signal rhs <== tauSq * neNo;
    component ge = GreaterEqThan(72);
    ge.in[0] <== dotSq * 100000000;
    ge.in[1] <== rhs;
    signal big <== ge.out;

    // 7. result === pos · big.
    result === pos * big;

    // 8. Bind the remaining public inputs (dummy quadratic constraints).
    signal betSq <== bet_field * bet_field;
    signal evSq <== evidence_field * evidence_field;
    signal pidxSq <== participant_idx * participant_idx;
    signal frameSq <== frame * frame;
    signal modSq <== modality * modality;
}

component main {public [commitment, bet_field, evidence_field, participant_idx, frame, modality, tau_bps, result]} = BiometricMatch(192);
