//! LiteSVM harness for the VERDICT program (no validator, no network, no SOL).
#![allow(dead_code, deprecated, clippy::result_large_err, clippy::too_many_arguments)]

pub mod payload;

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_sdk::{
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    instruction::InstructionError,
    program_pack::Pack,


    slot_hashes::SlotHashes,
    system_instruction,
    transaction::{Transaction, TransactionError},
};
use std::path::PathBuf;

pub use solana_sdk::signature::{Keypair, Signer};
pub use solana_sdk::pubkey::Pubkey;
pub use solana_sdk::instruction::{AccountMeta, Instruction};
pub use verdict::constants::*;
pub use verdict::state::{Bet, Profile};
pub use verdict::VerdictError;
pub use verdict::{HeadArg, WitnessArg};

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const T0: i64 = 1_800_000_000;
pub const SLOT0: u64 = 10_000;

pub fn program_so() -> PathBuf {
    if let Ok(p) = std::env::var("VERDICT_SO") {
        return PathBuf::from(p);
    }
    // `--features mock-zk` tests need a program built with that feature:
    //   cargo build-sbf --manifest-path programs/verdict/Cargo.toml --features mock-zk --sbf-out-dir target/deploy-mock-zk
    let dir = if cfg!(feature = "mock-zk") { "../../target/deploy-mock-zk/verdict.so" } else { "../../target/deploy/verdict.so" };
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(dir)
}

pub fn kp(seed: u8) -> Keypair {
    Keypair::new_from_array([seed; 32])
}

pub fn code(e: VerdictError) -> u32 {
    6000 + e as u32
}

/// Asserts the transaction failed with the given program error.
#[track_caller]
pub fn assert_err(res: TxResult, e: VerdictError) {
    match res {
        Ok(_) => panic!("expected {e:?}, transaction succeeded"),
        Err(f) => match f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) if c == code(e) => {}
            other => panic!("expected {e:?} ({}), got {other:?}\n{}", code(e), f.meta.pretty_logs()),
        },
    }
}

/// Asserts the transaction failed (any error).
#[track_caller]
pub fn assert_fails(res: TxResult) -> TransactionError {
    match res {
        Ok(m) => panic!("expected failure, got success\n{}", m.pretty_logs()),
        Err(f) => f.err,
    }
}

#[track_caller]
pub fn ok(res: TxResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.pretty_logs()),
    }
}

pub fn bet_pda(creator: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(&[BET_SEED, creator.as_ref(), &nonce.to_le_bytes()], &verdict::ID).0
}
pub fn vault_pda(bet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, bet.as_ref()], &verdict::ID).0
}
pub fn tracks_pda(bet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TRACKS_SEED, bet.as_ref()], &verdict::ID).0
}
pub fn profile_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PROFILE_SEED, wallet.as_ref()], &verdict::ID).0
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    solana_sdk::hash::hashv(parts).to_bytes()
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub oracle: Keypair,
    pub judges: [Keypair; 3],
    pub mint_auth: Keypair,
    pub mint: Pubkey,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = program_so();
        let bytes = std::fs::read(&so).unwrap_or_else(|_| panic!("{} missing: run `anchor build` first (mock-zk: see program_so())", so.display()));
        svm.add_program(verdict::ID, &bytes).expect("load program");
        let payer = kp(200);
        let oracle = kp(201);
        let judges = [kp(210), kp(211), kp(212)];
        let mint_auth = kp(220);
        for k in [&payer, &oracle, &mint_auth] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        let mut env = Env { svm, payer, oracle, judges, mint_auth, mint: Pubkey::default() };
        env.set_time(T0, SLOT0);
        env.mint = env.create_mint();
        env
    }

    pub fn set_time(&mut self, unix: i64, slot: u64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        c.slot = slot;
        self.svm.set_sysvar(&c);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn slot(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().slot
    }

    pub fn advance(&mut self, secs: i64) {
        let (t, s) = (self.now(), self.slot());
        self.set_time(t + secs, s + (secs.max(0) as u64) * 2);
    }

    /// Installs SlotHashes entries `(slot, hash)` (descending).
    pub fn set_slot_hashes(&mut self, entries: &[(u64, Hash)]) {
        self.svm.set_sysvar(&SlotHashes::new(entries));
    }

    pub fn send_with(&mut self, ixs: &[Instruction], signers: &[&Keypair], cu: Option<u32>) -> TxResult {
        let mut all = vec![];
        if let Some(cu) = cu {
            all.push(ComputeBudgetInstruction::set_compute_unit_limit(cu));
        }
        all.extend_from_slice(ixs);
        let mut keys: Vec<&Keypair> = vec![&self.payer];
        for s in signers {
            if !keys.iter().any(|k| k.pubkey() == s.pubkey()) {
                keys.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(&all, Some(&self.payer.pubkey()), &keys, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        self.send_with(ixs, signers, None)
    }

    pub fn airdrop(&mut self, to: &Pubkey, lamports: u64) {
        self.svm.airdrop(to, lamports).unwrap();
    }

    // ---------- SPL token ----------
    pub fn create_mint(&mut self) -> Pubkey {
        let mint = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
        let ixs = [
            system_instruction::create_account(&self.payer.pubkey(), &mint.pubkey(), rent, spl_token::state::Mint::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &self.mint_auth.pubkey(), None, 6).unwrap(),
        ];
        ok(self.send(&ixs, &[&mint]));
        mint.pubkey()
    }

    pub fn create_token_account(&mut self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        let acct = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
        let ixs = [
            system_instruction::create_account(&self.payer.pubkey(), &acct.pubkey(), rent, spl_token::state::Account::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_account3(&spl_token::ID, &acct.pubkey(), mint, owner).unwrap(),
        ];
        ok(self.send(&ixs, &[&acct]));
        acct.pubkey()
    }

    pub fn mint_to(&mut self, account: &Pubkey, amount: u64) {
        let ix = spl_token::instruction::mint_to(&spl_token::ID, &self.mint, account, &self.mint_auth.pubkey(), &[], amount).unwrap();
        let auth = self.mint_auth.insecure_clone();
        ok(self.send(&[ix], &[&auth]));
    }

    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        let a = self.svm.get_account(account).expect("token account");
        spl_token::state::Account::unpack(&a.data).unwrap().amount
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).map(|a| a.lamports > 0 || !a.data.is_empty()).unwrap_or(false)
    }

    // ---------- reads ----------
    pub fn bet(&self, key: &Pubkey) -> Bet {
        let a = self.svm.get_account(key).expect("bet account");
        Bet::try_deserialize(&mut &a.data[..]).expect("bet decode")
    }

    pub fn profile(&self, key: &Pubkey) -> Profile {
        let a = self.svm.get_account(key).expect("profile account");
        Profile::try_deserialize(&mut &a.data[..]).expect("profile decode")
    }

    pub fn judge_keys(&self) -> [Pubkey; 3] {
        [self.judges[0].pubkey(), self.judges[1].pubkey(), self.judges[2].pubkey()]
    }
}

/// Builds an Anchor instruction from its args struct and accounts struct.
pub fn ix(data: impl InstructionData, accounts: impl ToAccountMetas, remaining: &[AccountMeta]) -> Instruction {
    let mut metas = accounts.to_account_metas(None);
    metas.extend_from_slice(remaining);
    Instruction { program_id: verdict::ID, accounts: metas, data: data.data() }
}

pub fn terms_hash(oracle: &Pubkey, judges: &[Pubkey; 3], acceptance: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"VERDICT/TERMS/v1", oracle.as_ref(), judges[0].as_ref(), judges[1].as_ref(), judges[2].as_ref(), acceptance])
}

pub mod actor;
pub mod flow;
