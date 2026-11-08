/** Minimal typings for the parts of snarkjs the backend uses (the package ships none). */
declare module 'snarkjs' {
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasm: string, zkey: string): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
}
