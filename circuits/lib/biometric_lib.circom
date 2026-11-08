pragma circom 2.1.9;

// Helper templates for the Verdict biometric match circuit (CONTRACTS.md §8.4, §8.6).

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

// Asserts `in` is a non-zero field element: in * inv === 1.
template NonZero() {
    signal input in;
    signal inv;
    inv <-- in != 0 ? 1 / in : 0;
    in * inv === 1;
}

// Takes a signed quantized embedding value q (negatives as p - |q|) and outputs
// u = q + 128, constrained to [1, 255] (Num2Bits(8) + non-zero). This bounds q to [-127, 127].
template ShiftedByte() {
    signal input q;
    signal output u;
    u <== q + 128;
    component bits = Num2Bits(8);
    bits.in <== u;
    component nz = NonZero();
    nz.in <== u;
}

// Packs D bytes (each < 256) into ceil(D/31) field elements, 31 bytes per element,
// little-endian within each element (§8.4: F_k = Σ_j u_{31k+j} · 256^j).
template PackBytes31(D) {
    var N = (D + 30) \ 31;
    signal input bytes[D];
    signal output out[N];
    for (var k = 0; k < N; k++) {
        var acc = 0;
        var mul = 1;
        for (var j = 0; j < 31; j++) {
            if (31 * k + j < D) {
                acc += bytes[31 * k + j] * mul;
                mul *= 256;
            }
        }
        out[k] <== acc;
    }
}

// commit = Poseidon(F_0, …, F_{N-1}, salt) over u_i = q_i + 128 (§8.4).
// Also outputs the range-checked shifted bytes, unused by callers but kept for clarity.
template EmbeddingCommitment(D) {
    var N = (D + 30) \ 31;
    signal input q[D];
    signal input salt;
    signal output commit;

    component sb[D];
    component pack = PackBytes31(D);
    for (var i = 0; i < D; i++) {
        sb[i] = ShiftedByte();
        sb[i].q <== q[i];
        pack.bytes[i] <== sb[i].u;
    }

    component h = Poseidon(N + 1);
    for (var k = 0; k < N; k++) {
        h.inputs[k] <== pack.out[k];
    }
    h.inputs[N] <== salt;
    commit <== h.out;
}

// Signed inner product Σ a_i · b_i (field arithmetic; correct as a signed integer
// as long as |result| < p/2, which the callers' bounds guarantee).
template InnerProduct(D) {
    signal input a[D];
    signal input b[D];
    signal output out;
    signal prod[D];
    var acc = 0;
    for (var i = 0; i < D; i++) {
        prod[i] <== a[i] * b[i];
        acc += prod[i];
    }
    out <== acc;
}
