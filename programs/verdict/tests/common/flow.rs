//! A bet's lifecycle driven through the program's instructions.
#![allow(dead_code)]

use super::payload::*;
use super::*;
use solana_sdk::sysvar;

pub const STAKE: u64 = 5_000_000;
pub const INITIAL_BALANCE: u64 = 50_000_000;

/// Static description of a bet.
#[derive(Clone)]
pub struct Spec {
    pub nonce: u64,
    pub flags: u8,
    pub stakes: Vec<u64>,
    pub stake_each: u64,
    pub side_b_mask: u8,
    pub time_limit_s: u32,
    pub acceptance: [u8; 32],
    pub program_bin: Vec<u8>,
    pub calibration_bin: Vec<u8>,
    pub tracks_bin: Vec<u8>,
}

impl Spec {
    pub fn payload(&self) -> Vec<u8> {
        [self.program_bin.clone(), self.calibration_bin.clone(), self.tracks_bin.clone()].concat()
    }
    pub fn program_hash(&self) -> [u8; 32] {
        sha256(&[&self.program_bin])
    }
    pub fn calibration_hash(&self) -> [u8; 32] {
        if self.calibration_bin.is_empty() {
            [0; 32]
        } else {
            sha256(&[&self.calibration_bin])
        }
    }
}

pub struct Flow {
    pub env: Env,
    pub users: Vec<Keypair>,
    pub tokens: Vec<Pubkey>,
    pub spec: Spec,
    pub bet: Pubkey,
    pub witnesses: Vec<Keypair>,
}

/// The default 2-player rules program: leg 1 = `exists present(ball)`; true ⇒ side 1 (B) wins.
pub fn ball_program(users: &[Pubkey], stakes: &[u64], side_b_mask: u8, time_limit_s: u32) -> Vec<u8> {
    ProgramB {
        kind: 0,
        time_limit_s,
        participants: users.to_vec(),
        stakes: stakes.to_vec(),
        side_b_mask,
        entities: vec![(EK_OBJECT, 0)],
        legs: vec![LegB::exists(1, present(0))],
        if_true: 1,
        else_side: 0,
        cond: cond_leg(1),
    }
    .encode()
}

/// One object track, frames `[0, n)`, ball present from `appear_at` on (or never).
pub fn ball_tracks(n: u16, appear_at: Option<u32>) -> Vec<u8> {
    tracks_bin(FLAGS_OK, &[(0, 0xFF, 0)], &[(0, n)], |_, f| match appear_at {
        Some(a) if f >= a => at(5000, 5000, 200),
        _ => ABSENT,
    })
}

pub fn default_users(n: usize) -> Vec<Keypair> {
    (0..n).map(|i| kp(1 + i as u8)).collect()
}

impl Flow {
    /// Rules bet among `n` users, ball appears (side B wins) iff `ball`.
    pub fn rules(n: usize, ball: bool) -> Flow {
        let users = default_users(n);
        let keys: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
        let stakes = vec![STAKE; n];
        let side_b_mask = 0b10;
        let spec = Spec {
            nonce: 7,
            flags: 0,
            stakes: stakes.clone(),
            stake_each: STAKE,
            side_b_mask,
            time_limit_s: 60,
            acceptance: [0x42; 32],
            program_bin: ball_program(&keys, &stakes, side_b_mask, 60),
            calibration_bin: calibration(&[]),
            tracks_bin: ball_tracks(40, if ball { Some(12) } else { None }),
        };
        Flow::with(Env::new(), users, spec)
    }

    pub fn with(mut env: Env, users: Vec<Keypair>, spec: Spec) -> Flow {
        let mut tokens = vec![];
        for u in &users {
            env.airdrop(&u.pubkey(), 10_000_000_000);
            let mint = env.mint;
            let t = env.create_token_account(&u.pubkey(), &mint);
            env.mint_to(&t, INITIAL_BALANCE);
            tokens.push(t);
        }
        let bet = bet_pda(&users[0].pubkey(), spec.nonce);
        let witnesses = vec![kp(100), kp(101)];
        Flow { env, users, tokens, spec, bet, witnesses }
    }

    pub fn keys(&self) -> Vec<Pubkey> {
        self.users.iter().map(|u| u.pubkey()).collect()
    }

    pub fn bet(&self) -> Bet {
        self.env.bet(&self.bet)
    }

    pub fn vault(&self) -> Pubkey {
        vault_pda(&self.bet)
    }

    pub fn tracks(&self) -> Pubkey {
        tracks_pda(&self.bet)
    }

    pub fn balance(&self, i: usize) -> u64 {
        self.env.token_balance(&self.tokens[i])
    }

    pub fn payout_metas(&self) -> Vec<AccountMeta> {
        self.tokens.iter().map(|t| AccountMeta::new(*t, false)).collect()
    }

    // ---------- instructions ----------
    pub fn create_ix(&self, spec: &Spec, participants: Vec<Pubkey>, judges: [Pubkey; 3]) -> Instruction {
        let creator = self.users[0].pubkey();
        let bet = bet_pda(&creator, spec.nonce);
        ix(
            verdict::instruction::CreateBet {
                nonce: spec.nonce,
                participants,
                stakes: spec.stakes.clone(),
                side_b_mask: spec.side_b_mask,
                stake_each: spec.stake_each,
                time_limit_s: spec.time_limit_s,
                flags: spec.flags,
                program_hash: spec.program_hash(),
                acceptance_audio_hash: spec.acceptance,
                judges,
            },
            verdict::accounts::CreateBet {
                payer: self.env.payer.pubkey(),
                creator,
                oracle: self.env.oracle.pubkey(),
                bet,
                vault: vault_pda(&bet),
                mint: self.env.mint,
                token_program: spl_token::ID,
                system_program: solana_sdk::system_program::ID,
            },
            &[],
        )
    }

    pub fn try_create_spec(&mut self, spec: &Spec) -> TxResult {
        let ixn = self.create_ix(spec, self.keys(), self.env.judge_keys());
        let (c, o) = (self.users[0].insecure_clone(), self.env.oracle.insecure_clone());
        self.env.send(&[ixn], &[&c, &o])
    }

    pub fn create(&mut self) {
        let spec = self.spec.clone();
        ok(self.try_create_spec(&spec));
    }

    pub fn terms(&self) -> [u8; 32] {
        terms_hash(&self.env.oracle.pubkey(), &self.env.judge_keys(), &self.spec.acceptance)
    }

    pub fn fund_ix(&self, i: usize, calibration_hash: [u8; 32], program_hash: [u8; 32], terms: [u8; 32]) -> Instruction {
        ix(
            verdict::instruction::Fund { calibration_hash, program_hash, terms_hash: terms },
            verdict::accounts::Fund {
                participant: self.users[i].pubkey(),
                bet: self.bet,
                vault: self.vault(),
                participant_token: self.tokens[i],
                token_program: spl_token::ID,
            },
            &[],
        )
    }

    pub fn try_fund(&mut self, i: usize) -> TxResult {
        let ixn = self.fund_ix(i, self.spec.calibration_hash(), self.spec.program_hash(), self.terms());
        let u = self.users[i].insecure_clone();
        self.env.send(&[ixn], &[&u])
    }

    pub fn fund_all(&mut self) {
        for i in 0..self.users.len() {
            ok(self.try_fund(i));
        }
    }

    pub fn start_ix(&self, authority: &Pubkey, beacon_slot: u64, witnesses: Vec<WitnessArg>) -> Instruction {
        ix(
            verdict::instruction::Start { beacon_slot, witnesses },
            verdict::accounts::Start { authority: *authority, bet: self.bet, slot_hashes: sysvar::slot_hashes::ID },
            &[],
        )
    }

    pub fn witness_args(&self) -> Vec<WitnessArg> {
        self.witnesses.iter().enumerate().map(|(i, w)| WitnessArg { key: w.pubkey(), kind: (i % 2) as u8 }).collect()
    }

    /// Beacon at `slot - 5` with a deterministic hash.
    pub fn beacon(&mut self) -> (u64, [u8; 32]) {
        let slot = self.env.slot();
        let bslot = slot - 5;
        let h = [0x77; 32];
        self.env.set_slot_hashes(&[(slot - 1, Hash::new_from_array([1; 32])), (bslot, Hash::new_from_array(h)), (bslot - 1, Hash::new_from_array([2; 32]))]);
        (bslot, h)
    }

    pub fn try_start(&mut self) -> TxResult {
        let (bslot, _) = if self.spec.flags & FLAG_MARKET != 0 { (0, [0; 32]) } else { self.beacon() };
        let w = if self.spec.flags & FLAG_MARKET != 0 { vec![] } else { self.witness_args() };
        let ixn = self.start_ix(&self.env.oracle.pubkey(), bslot, w);
        let o = self.env.oracle.insecure_clone();
        self.env.send(&[ixn], &[&o])
    }

    pub fn commit_ix(&self, seq: u32, heads: Vec<HeadArg>) -> Instruction {
        ix(
            verdict::instruction::CommitEvidence { seq, heads },
            verdict::accounts::CommitEvidence { oracle: self.env.oracle.pubkey(), bet: self.bet },
            &[],
        )
    }

    pub fn try_commit(&mut self, seq: u32, heads: Vec<HeadArg>) -> TxResult {
        let ixn = self.commit_ix(seq, heads);
        let o = self.env.oracle.insecure_clone();
        self.env.send(&[ixn], &[&o])
    }

    pub fn end_ix(&self, authority: &Pubkey, seq: u32, heads: Vec<HeadArg>) -> Instruction {
        ix(verdict::instruction::End { seq, heads }, verdict::accounts::End { authority: *authority, bet: self.bet }, &[])
    }

    pub fn try_end(&mut self, signer: &Keypair, seq: u32, heads: Vec<HeadArg>) -> TxResult {
        let ixn = self.end_ix(&signer.pubkey(), seq, heads);
        self.env.send(&[ixn], &[signer])
    }

    pub fn end_by_oracle(&mut self) {
        let o = self.env.oracle.insecure_clone();
        ok(self.try_end(&o, 0, vec![]));
    }

    pub fn post_ix(&self, payload_len: u32, program_len: u16, calibration_len: u16, offset: u32, data: Vec<u8>, finalize: bool, root: [u8; 32]) -> Instruction {
        ix(
            verdict::instruction::PostTracks { payload_len, program_len, calibration_len, offset, data, finalize, perception_root: root },
            verdict::accounts::PostTracks {
                payer: self.env.payer.pubkey(),
                oracle: self.env.oracle.pubkey(),
                bet: self.bet,
                track_buffer: self.tracks(),
                system_program: solana_sdk::system_program::ID,
            },
            &[],
        )
    }

    /// Posts `payload` in POST_TRACKS_CHUNK chunks, finalizing on the last.
    pub fn try_post_payload(&mut self, payload: &[u8], program_len: usize, calibration_len: usize) -> TxResult {
        let o = self.env.oracle.insecure_clone();
        let chunks: Vec<&[u8]> = payload.chunks(POST_TRACKS_CHUNK).collect();
        let mut last = None;
        for (i, c) in chunks.iter().enumerate() {
            let fin = i + 1 == chunks.len();
            let ixn = self.post_ix(payload.len() as u32, program_len as u16, calibration_len as u16, (i * POST_TRACKS_CHUNK) as u32, c.to_vec(), fin, [0x99; 32]);
            let r = self.env.send(&[ixn], &[&o]);
            if r.is_err() {
                return r;
            }
            last = Some(r);
        }
        last.expect("non-empty payload")
    }

    pub fn post_tracks(&mut self) {
        let p = self.spec.payload();
        let (pl, cl) = (self.spec.program_bin.len(), self.spec.calibration_bin.len());
        ok(self.try_post_payload(&p, pl, cl));
    }

    pub fn run_rules_ix(&self) -> Instruction {
        ix(
            verdict::instruction::RunRules {},
            verdict::accounts::RunRules { oracle: self.env.oracle.pubkey(), bet: self.bet, track_buffer: self.tracks() },
            &[],
        )
    }

    pub fn try_run_rules(&mut self) -> TxResult {
        let ixn = self.run_rules_ix();
        let o = self.env.oracle.insecure_clone();
        self.env.send_with(&[ixn], &[&o], Some(1_400_000))
    }

    pub fn consent_ix(&self, authority: &Pubkey, winner_mask: u8, root: [u8; 32]) -> Instruction {
        ix(
            verdict::instruction::Consent { winner_mask, evidence_root: root },
            verdict::accounts::Consent {
                authority: *authority,
                bet: self.bet,
                vault: self.vault(),
                oracle: self.env.oracle.pubkey(),
                track_buffer: self.tracks(),
                token_program: spl_token::ID,
            },
            &self.payout_metas(),
        )
    }

    pub fn try_consent(&mut self, signer: &Keypair) -> TxResult {
        let b = self.bet();
        let ixn = self.consent_ix(&signer.pubkey(), b.winner_mask, b.evidence_root);
        self.env.send(&[ixn], &[signer])
    }

    pub fn dispute_ix(&self, i: usize, reason: u8, root: [u8; 32]) -> Instruction {
        ix(
            verdict::instruction::Dispute { reason, evidence_root: root },
            verdict::accounts::Dispute {
                disputer: self.users[i].pubkey(),
                bet: self.bet,
                vault: self.vault(),
                disputer_token: self.tokens[i],
                token_program: spl_token::ID,
            },
            &[],
        )
    }

    pub fn try_dispute(&mut self, i: usize, reason: u8) -> TxResult {
        let ixn = self.dispute_ix(i, reason, self.bet().evidence_root);
        let u = self.users[i].insecure_clone();
        self.env.send(&[ixn], &[&u])
    }

    pub fn settle_panel_ix(&self, outcome: u8) -> Instruction {
        ix(
            verdict::instruction::SettlePanel { outcome },
            verdict::accounts::SettlePanel {
                bet: self.bet,
                vault: self.vault(),
                oracle: self.env.oracle.pubkey(),
                track_buffer: self.tracks(),
                token_program: spl_token::ID,
                instructions: sysvar::instructions::ID,
            },
            &self.payout_metas(),
        )
    }

    pub fn panel_message(&self, outcome: u8) -> [u8; 145] {
        let b = self.bet();
        verdict::crypto::panel_message(&verdict::ID, &self.bet, outcome, &b.evidence_root, &b.program_hash)
    }

    /// Ed25519 precompile instruction with signatures from judges `j0`, `j1` over `msg`.
    pub fn ed25519_ix(&self, j0: &Keypair, j1: &Keypair, msg: &[u8; 145]) -> Instruction {
        let s0: [u8; 64] = j0.sign_message(msg).into();
        let s1: [u8; 64] = j1.sign_message(msg).into();
        let data = verdict::panel::build_ed25519_data(&j0.pubkey().to_bytes(), &s0, &j1.pubkey().to_bytes(), &s1, msg);
        Instruction { program_id: verdict::panel::ED25519_PROGRAM_ID, accounts: vec![], data: data.to_vec() }
    }

    pub fn try_settle_panel(&mut self, outcome: u8, j0: usize, j1: usize) -> TxResult {
        let msg = self.panel_message(outcome);
        let ed = self.ed25519_ix(&self.env.judges[j0], &self.env.judges[j1], &msg);
        let ixn = self.settle_panel_ix(outcome);
        self.env.send(&[ed, ixn], &[])
    }

    pub fn refund_ix(&self) -> Instruction {
        ix(
            verdict::instruction::Refund {},
            verdict::accounts::Refund {
                bet: self.bet,
                vault: self.vault(),
                oracle: self.env.oracle.pubkey(),
                track_buffer: self.tracks(),
                token_program: spl_token::ID,
            },
            &self.payout_metas(),
        )
    }

    pub fn try_refund(&mut self) -> TxResult {
        let ixn = self.refund_ix();
        self.env.send(&[ixn], &[])
    }

    pub fn cancel_ix(&self, creator: &Pubkey) -> Instruction {
        ix(
            verdict::instruction::Cancel {},
            verdict::accounts::Cancel {
                creator: *creator,
                bet: self.bet,
                vault: self.vault(),
                oracle: self.env.oracle.pubkey(),
                track_buffer: self.tracks(),
                token_program: spl_token::ID,
            },
            &self.payout_metas(),
        )
    }

    /// create → fund → start → end (oracle, no heads) → post_tracks.
    pub fn to_tracks_posted(&mut self) {
        self.create();
        self.fund_all();
        ok(self.try_start());
        self.env.advance(30);
        self.end_by_oracle();
        self.post_tracks();
    }

    /// … → run_rules (expects success).
    pub fn to_preruled(&mut self) -> TransactionMetadata {
        self.to_tracks_posted();
        ok(self.try_run_rules())
    }
}
