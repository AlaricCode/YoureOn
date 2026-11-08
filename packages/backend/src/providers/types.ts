/**
 * Provider interfaces for every external dependency in §13. Each has a
 * deterministic mock (providers/mock) selected by default; paid modes assert
 * the spend guard when constructed (providers/real).
 */
import type {
  Calibration,
  EncodedGroth16Proof,
  MockScenario,
  Program,
  RawDetection,
  SessionTracks,
} from '@verdict/engine';

// ---- compiler (COMPILER_PROVIDER) ----------------------------------------------

export interface Question {
  id: string;
  /** ≤ 6 words */
  text: string;
  kind: 'choice' | 'multi' | 'free' | 'region';
  chips: string[];
  entity?: string;
  audio_url: string | null;
}

export interface CompileRequest {
  transcript: string;
  creator_user_id: string;
  /** confirmed huddle members in join order (creator first); index = `pN` */
  members: { user_id: string; display_name: string; wallet: string }[];
  /** answers to earlier questions */
  answers?: { question_id: string; answer: string }[];
  /** the current draft's YAML/title when recompiling */
  previous?: { yaml: string | null; title: string | null; transcript: string | null };
  /** recompile: engine validation errors for `rejected_yaml` (the previous attempt) */
  errors?: { path: string; code: string; message: string }[];
  rejected_yaml?: string | null;
}

export interface CompileResult {
  kind: 'rules' | 'ai_judged' | 'market';
  /** ≤ 40 chars, 1–5 words; not hashed */
  title: string | null;
  /** surface YAML (§2.5) for engine.parseYaml; null while it cannot be produced yet */
  yaml: string | null;
  questions: Question[];
  /** entity → 1–3 word Title-case label */
  labels: Record<string, string>;
  /** which template produced it (mock) or the model id (real) */
  source: string;
}

export interface CompilerProvider {
  readonly name: string;
  compile(req: CompileRequest): Promise<CompileResult>;
}

// ---- booth: advocates (ADVOCATE_PROVIDER) and judges (JUDGE_PROVIDERS) ---------

export interface ExhibitSummary {
  id: string;
  kind: string;
  witness: string | null;
  t_start_ms: number;
  t_end_ms: number;
}

export interface BoothCase {
  bet: string;
  program: Program;
  readback: string[];
  /** 0 none / 1 WINNER / 2 NO_CONTEST / 3 NEEDS_PANEL */
  preruling: number;
  /** winning side of the pre-ruling, if any */
  preruling_side: 0 | 1 | null;
  reason: number;
  ai_judged: boolean;
  /** ai_judged question and the transcript excerpt the judges see */
  question: string | null;
  transcript: string;
  exhibits: ExhibitSummary[];
  /** raw exhibit bytes (multimodal judges/advocates); absent in mocks/tests */
  exhibitBytes?: (id: string) => Uint8Array | null;
}

export interface AdvocateBrief {
  side: 0 | 1;
  /** ≤ 600 chars */
  claim: string;
  citations: string[];
  exhibits: string[];
}

export interface AdvocateProvider {
  readonly name: string;
  brief(c: BoothCase, side: 0 | 1, exhibitSlots: number): Promise<AdvocateBrief>;
}

export interface JudgeVote {
  /** 0 no contest, 1 side 0 wins, 2 side 1 wins */
  outcome: 0 | 1 | 2;
  confidence_bps: number;
  /** ≤ 1000 chars */
  rationale: string;
}

export interface JudgeProvider {
  readonly name: string;
  /** J0 must take clips as video (§10.3) */
  readonly videoNative: boolean;
  judge(c: BoothCase, briefs: AdvocateBrief[], judgeIndex: number): Promise<JudgeVote>;
}

// ---- voice: agent, STT, TTS, SFX ------------------------------------------------

export interface AgentProvider {
  readonly name: string;
  createSession(req: { huddle_id: string; draft_id: string | null; user_id: string }): Promise<{
    mode: 'mock' | 'elevenlabs';
    signed_url: string | null;
  }>;
}

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  audio_events: { t_ms: number; label: string }[];
}

export interface SttContext {
  /** `x-mock-transcript` request header (mock only) */
  mock_transcript?: string | null;
  /** the draft's last transcript (mock fallback 1) */
  draft_transcript?: string | null;
  /** the acceptance challenge phrase (mock fallback 2) */
  challenge_phrase?: string | null;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Uint8Array, ctx?: SttContext): Promise<Transcript>;
}

export interface AudioBlob {
  mime: 'audio/wav' | 'audio/mpeg';
  bytes: Uint8Array;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(text: string): Promise<AudioBlob>;
}

export interface SfxProvider {
  readonly name: string;
  /** The start sound (≤ 1.5 s, D-8). */
  startSound(): Promise<AudioBlob>;
}

// ---- perception (PERCEPTION_PROVIDER), detector, identity ----------------------

export interface PerceptionVideo {
  index: number;
  url: string;
  sha256: string;
  start_ms: number;
  duration_ms: number;
  body_format: 'mp4' | 'mjpeg';
}

export interface PerceptionRequest {
  bet: string;
  program: Program;
  calibration: Calibration | null;
  /** §6.0 job fields */
  offset_ms: number;
  video_urls: PerceptionVideo[];
  prompts: { entity: string; phrase: string }[];
  need_pose: boolean;
  need_reid: boolean;
  /** mock: seed for engine.simulate */
  seed: number;
}

export interface PerceptionHostResult {
  host: { provider: string; job_id: string; url: string | null; market: string | null };
  network: 'mainnet' | 'mock';
  model_hash: string;
  flags: number;
  /** real hosts: RawDetection JSON Lines (quantize with engine.quantizeSession) */
  raw: RawDetection[] | null;
  /** mock hosts: already-quantized tracks from engine.simulate */
  session: SessionTracks | null;
}

export interface PerceptionProvider {
  readonly name: string;
  /** Runs two independent jobs (hosts A and B, §6.0); A = the first to finish. */
  runPair(req: PerceptionRequest): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }>;
}

export interface Detection {
  entity: string;
  bbox: [number, number, number, number];
  /** percent 0..100 */
  conf: number;
}

export interface DetectorProvider {
  readonly name: string;
  detect(
    jpeg: Uint8Array,
    ctx: { bet: string; entities: { entity: string; phrase: string }[]; calibration: Calibration | null },
  ): Promise<Detection[]>;
}

export interface IdentitySubject {
  /** Mock only: whose face/voice the bytes depict (the service decides, §13). */
  subject_user_id?: string | null;
}

export interface IdentityProvider {
  readonly name: string;
  /** L2-normalized 128-d face embedding (§8.1) */
  embedFace(jpeg: Uint8Array, ctx?: IdentitySubject): Promise<number[]>;
  /** L2-normalized 192-d voice embedding (§8.1) */
  embedVoice(wav: Uint8Array, ctx?: IdentitySubject): Promise<number[]>;
}

// ---- world (GEMINI_PROVIDER / GEMINI_HEDGE) ------------------------------------

export interface WorldContract {
  id: string;
  label: string;
  prob_bps: number;
  bid_bps?: number;
  ask_bps?: number;
}

export interface WorldEvent {
  id: string;
  title: string;
  category: string;
  close_time_ms: number;
  status: 'open' | 'closed' | 'resolved';
  contracts: WorldContract[];
  resolution?: { contract_id: string; result: 'yes' | 'no' | 'void' }[];
}

export interface WorldPrice {
  event_id: string;
  contract_id: string;
  prob_bps: number;
  at_ms: number;
}

export interface GeminiProvider {
  readonly name: string;
  listEvents(q: string | null, limit: number): Promise<WorldEvent[]>;
  getEvent(id: string): Promise<WorldEvent | null>;
  /** Live price stream for one event; returns an unsubscribe function. */
  subscribePrices(eventId: string, onPrice: (p: WorldPrice) => void): () => void;
}

export interface HedgeProvider {
  readonly name: string;
  placeOrder(req: { bet: string; contract_id: string; side: 'yes' | 'no'; amount_units: number }): Promise<{
    order_id: string;
    status: string;
  }>;
}

// ---- proving (PROVER, SP1_PROVER) ------------------------------------------------

export interface ProverProvider {
  readonly name: string;
  /** Groth16 proof for the biometric circuit (§8.6) from the circuit witness input. */
  proveBiometric(input: Record<string, unknown>): Promise<{ proof: EncodedGroth16Proof; publicSignals: string[] }>;
  /** Optional verifier used by the mock chain (snarkjs mode). */
  verifier?: (publicInputs: Uint8Array[], proof: EncodedGroth16Proof) => boolean;
}

export interface Sp1Provider {
  readonly name: string;
  readonly enabled: boolean;
  proveRun(input: { bet: string; payload: Uint8Array }): Promise<{ public_values: Uint8Array; proof: Uint8Array }>;
}

// ---- the full set ------------------------------------------------------------------

export interface Providers {
  compiler: CompilerProvider;
  advocate: AdvocateProvider;
  judges: [JudgeProvider, JudgeProvider, JudgeProvider];
  agent: AgentProvider;
  stt: SttProvider;
  tts: TtsProvider;
  sfx: SfxProvider;
  perception: PerceptionProvider;
  detector: DetectorProvider;
  identity: IdentityProvider;
  gemini: GeminiProvider;
  hedge: HedgeProvider;
  prover: ProverProvider;
  sp1: Sp1Provider;
  /** MOCK_SCENARIO (drives simulate and the booth paths) */
  mockScenario: MockScenario;
}
