//! Shared LiteSVM harness for the ESCROW §9.2 matrix.
//!
//! Layout:
//! - `Env` fixture: program, keys (admin, J, AP, S, A, B, Mallory), a classic 6-dp "USDC" mint
//!   and one funded token account each for A, B and Mallory.
//! - D0 builders: `ix_initialize_config`, `ix_update_config`, `ix_create_bet`, `ix_accept_bet`.
//! - D1 builders (§5.2): `ix_cancel_open_bet`, `ix_resolve`, `ix_concede`, `ix_appeal`,
//!   `ix_resolve_appeal`, `ix_finalize`, `ix_timeout_refund`, `ix_close_bet`, with account
//!   structs `PayoutAccts`, `ResolveAccts`, `AppealAccts`, `CloseAccts` and `default_*` fillers.
//! - D1 senders: one standalone and one `_bundled` (`[terminal ix, close_bet]`, §5.0 step 4)
//!   sender per terminal instruction, plus `send_bundled` for custom terminal ixs.
//! - D1 state drivers: `locked_bet`, `resolved_bet`, `appealed_bet`, `settled_bet`, ... which drive
//!   a bet to each §8.2 status through the real instructions.
//! - §9.1 global post-conditions: `Snapshot::take` before a terminal tx, then
//!   `assert_terminal_postconditions_bundled` / `_standalone` after it, and
//!   `assert_close_postconditions` after a standalone `close_bet`.

#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        bpf_loader_upgradeable,
        clock::Clock,
        instruction::{AccountMeta, Instruction},
        program_option::COption,
        program_pack::Pack,
        system_program,
    },
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use anchor_spl::token_interface::spl_token_2022;
use escrow::{
    payout::{compute_payout, PayoutKind},
    AppealResolved, Bet, BetCancelled, BetClosed, BetConceded, BetFinalized, BetRefunded,
    BetStatus, Config, EscrowError, InitConfigArgs, Outcome, UpdateConfigArgs, BET_SEED,
    CONFIG_SEED, VAULT_SEED,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError};

pub const CLASSIC_TOKEN: Pubkey = spl_token_2022_classic_id();
pub const TOKEN_2022: Pubkey = spl_token_2022::ID;
pub const COMPUTE_BUDGET: Pubkey =
    anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");

const fn spl_token_2022_classic_id() -> Pubkey {
    anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}

pub const NOW: i64 = 1_800_000_000;
pub const USDC_5: u64 = 5_000_000;
pub const MAX_STAKE: u64 = 20_000_000;
pub const FUNDED: u64 = 100_000_000; // 100 USDC per party token account
pub const TERMS: [u8; 32] = [7u8; 32];

// Anchor framework error codes (anchor-lang 1.2.2 ErrorCode).
pub const ANCHOR_CONSTRAINT_RAW: u32 = 2003;
pub const ANCHOR_CONSTRAINT_SEEDS: u32 = 2006;
pub const ANCHOR_CONSTRAINT_TOKEN_MINT: u32 = 2014;
pub const ANCHOR_CONSTRAINT_TOKEN_OWNER: u32 = 2015;
pub const ANCHOR_CONSTRAINT_MINT_TOKEN_PROGRAM: u32 = 2022;
pub const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
pub const ANCHOR_ACCOUNT_NOT_SIGNER: u32 = 3010;
pub const ANCHOR_INVALID_PROGRAM_ID: u32 = 3008;
pub const ANCHOR_CONSTRAINT_HAS_ONE: u32 = 2001;
pub const ANCHOR_CONSTRAINT_ADDRESS: u32 = 2012;
pub const ANCHOR_CONSTRAINT_TOKEN_TOKEN_PROGRAM: u32 = 2021;
/// The same `Account`/`InterfaceAccount` passed twice as mutable (Anchor 1.2.2 checks only
/// serializing types, so `payer == rent_payer` in `close_bet` is NOT affected; TM-U3).
pub const ANCHOR_CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT: u32 = 2040;
pub const ANCHOR_ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;

/// Default non-zero hashes for `resolve` / `resolve_appeal` (all-zero is `EmptyHash`).
pub const EVIDENCE: [u8; 32] = [0x11; 32];
pub const RULING: [u8; 32] = [0x22; 32];
pub const APPEAL_RULING: [u8; 32] = [0x33; 32];

/// Demo windows from `demo_args` (§3.1), snapshotted into every bet created by `Env`.
pub const APPEAL_WINDOW_SECS: i64 = 10;
pub const ACCEPT_WINDOW_SECS: i64 = 600;
pub const RESOLVE_WINDOW_SECS: i64 = 3600;
pub const APPEAL_RESOLVE_SECS: i64 = 300;

pub fn err_code(e: escrow::EscrowError) -> u32 {
    6000 + e as u32
}

pub struct Sent {
    pub meta: TransactionMetadata,
    pub keys: Vec<Pubkey>,
}

pub type SendResult = Result<Sent, FailedTransactionMetadata>;

pub struct Env {
    pub svm: LiteSVM,
    pub program_id: Pubkey,
    pub admin: Keypair,
    pub judge: Keypair,
    pub appeal: Keypair,
    /// Server fee payer `S`.
    pub s: Keypair,
    pub a: Keypair,
    pub b: Keypair,
    pub mallory: Keypair,
    pub usdc: Pubkey,
    pub a_token: Pubkey,
    pub b_token: Pubkey,
    pub mallory_token: Pubkey,
}

pub fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &escrow::ID).0
}

pub fn bet_pda(bet_id: &[u8; 16]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BET_SEED, bet_id], &escrow::ID)
}

pub fn vault_pda(bet_id: &[u8; 16]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, bet_id], &escrow::ID)
}

pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &escrow::ID).0
}

pub fn demo_args(judge: Pubkey, appeal: Pubkey, mints: Vec<Pubkey>) -> InitConfigArgs {
    InitConfigArgs {
        judge_authority: judge,
        appeal_authority: appeal,
        max_stake: MAX_STAKE,
        appeal_window_secs: 10,
        accept_deadline_secs: 600,
        resolve_deadline_secs: 3600,
        appeal_resolve_secs: 300,
        allowed_mints: mints,
    }
}

/// `create_bet` arguments.
#[derive(Clone, Debug)]
pub struct CreateArgs {
    pub bet_id: [u8; 16],
    pub party_b: Pubkey,
    pub stake_a: u64,
    pub stake_b: u64,
    pub terms_hash: [u8; 32],
    pub accept_deadline: i64,
}

/// `create_bet` accounts (PDAs default to the ones derived from `bet_id`).
#[derive(Clone, Debug)]
pub struct CreateAccts {
    pub payer: Pubkey,
    pub party_a: Pubkey,
    pub config: Pubkey,
    pub mint: Pubkey,
    pub bet: Pubkey,
    pub vault: Pubkey,
    pub party_a_token: Pubkey,
    pub token_program: Pubkey,
}

/// `accept_bet` arguments.
#[derive(Clone, Debug)]
pub struct AcceptArgs {
    pub expected_terms_hash: [u8; 32],
    pub expected_stake_a: u64,
    pub expected_stake_b: u64,
    pub expected_party_a: Pubkey,
}

#[derive(Clone, Debug)]
pub struct AcceptAccts {
    pub payer: Pubkey,
    pub party_b: Pubkey,
    pub config: Pubkey,
    pub bet: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub party_b_token: Pubkey,
    pub token_program: Pubkey,
}

pub fn bet_id(n: u8) -> [u8; 16] {
    let mut id = [0u8; 16];
    id[0] = 0xb0;
    id[15] = n;
    id
}

impl Env {
    /// Program loaded under the upgradeable loader with `admin` as upgrade authority; SPL Token
    /// and Token-2022 present; a classic 6-dp "USDC" mint; A, B and Mallory each hold 100 USDC
    /// and 0 SOL (Mallory has SOL so she can front-run as her own payer).
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program_id = escrow::ID;
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/escrow.so"));
        svm.add_program(program_id, bytes).unwrap();

        let admin = Keypair::new();
        // ESCROW §9.1 gotcha: LiteSVM writes ProgramData with upgrade_authority = None.
        set_upgrade_authority(&mut svm, &program_id, Some(admin.pubkey()));

        let s = Keypair::new();
        let mallory = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&s.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();

        let mut env = Env {
            svm,
            program_id,
            admin,
            judge: Keypair::new(),
            appeal: Keypair::new(),
            s,
            a: Keypair::new(),
            b: Keypair::new(),
            mallory,
            usdc: Pubkey::default(),
            a_token: Pubkey::default(),
            b_token: Pubkey::default(),
            mallory_token: Pubkey::default(),
        };
        env.set_now(NOW);
        env.usdc = env.create_mint(6, CLASSIC_TOKEN);
        env.a_token = env.create_token_account(env.usdc, env.a.pubkey(), FUNDED, CLASSIC_TOKEN);
        env.b_token = env.create_token_account(env.usdc, env.b.pubkey(), FUNDED, CLASSIC_TOKEN);
        env.mallory_token =
            env.create_token_account(env.usdc, env.mallory.pubkey(), FUNDED, CLASSIC_TOKEN);
        env
    }

    /// `Env::new()` + `initialize_config` with the demo values (§3.1), allowlist = [usdc].
    pub fn with_config() -> Self {
        let mut env = Self::new();
        let args = demo_args(env.judge.pubkey(), env.appeal.pubkey(), vec![env.usdc]);
        env.initialize_config(&args).expect("initialize_config");
        env
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_now(&mut self, ts: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
    }

    // ---------- token fixtures (state written directly with Pack) ----------

    pub fn create_mint(&mut self, decimals: u8, token_program: Pubkey) -> Pubkey {
        let mint = Pubkey::new_unique();
        let mut data = vec![0u8; spl_token_2022::state::Mint::LEN];
        spl_token_2022::state::Mint {
            mint_authority: COption::Some(Pubkey::new_unique()),
            supply: 1_000_000_000_000,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.put(mint, data, token_program);
        mint
    }

    pub fn create_token_account(
        &mut self,
        mint: Pubkey,
        owner: Pubkey,
        amount: u64,
        token_program: Pubkey,
    ) -> Pubkey {
        let addr = Pubkey::new_unique();
        self.write_token_account(addr, mint, owner, amount, token_program);
        addr
    }

    pub fn write_token_account(
        &mut self,
        addr: Pubkey,
        mint: Pubkey,
        owner: Pubkey,
        amount: u64,
        token_program: Pubkey,
    ) {
        let mut data = vec![0u8; spl_token_2022::state::Account::LEN];
        spl_token_2022::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token_2022::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.put(addr, data, token_program);
    }

    fn put(&mut self, addr: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(addr, solana_account(lamports, data, owner))
            .unwrap();
    }

    /// A real SPL `transfer_checked` (6 dp) from `from` (owned by `owner`) to `to`; S pays the fee.
    pub fn transfer_tokens(
        &mut self,
        from: Pubkey,
        owner: &Keypair,
        to: Pubkey,
        mint: Pubkey,
        amount: u64,
        token_program: Pubkey,
    ) -> SendResult {
        let ix = spl_token_2022::instruction::transfer_checked(
            &token_program,
            &from,
            &mint,
            &to,
            &owner.pubkey(),
            &[],
            amount,
            6,
        )
        .unwrap();
        let s = self.s.insecure_clone();
        self.send(&[ix], &s, &[owner])
    }

    /// Writes extra tokens into an account without minting (state set-up only).
    pub fn add_tokens(&mut self, addr: Pubkey, units: u64) {
        let mut acc = self.svm.get_account(&addr).unwrap();
        let mut ta = spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165]).unwrap();
        ta.amount += units;
        ta.pack_into_slice(&mut acc.data[..165]);
        self.svm.set_account(addr, acc).unwrap();
    }

    pub fn token_balance(&self, addr: &Pubkey) -> u64 {
        let acc = self.svm.get_account(addr).expect("token account exists");
        spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165])
            .unwrap()
            .amount
    }

    pub fn sol(&self, addr: &Pubkey) -> u64 {
        self.svm.get_balance(addr).unwrap_or(0)
    }

    pub fn exists(&self, addr: &Pubkey) -> bool {
        self.svm
            .get_account(addr)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    pub fn config(&self) -> Config {
        let acc = self.svm.get_account(&config_pda()).expect("config exists");
        Config::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    pub fn bet(&self, bet_id: &[u8; 16]) -> escrow::Bet {
        let acc = self
            .svm
            .get_account(&bet_pda(bet_id).0)
            .expect("bet exists");
        escrow::Bet::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    /// Overwrite the Bet's status in place (state set-up for rows that need D1 instructions).
    pub fn force_status(&mut self, bet_id: &[u8; 16], status: BetStatus) {
        let addr = bet_pda(bet_id).0;
        let mut acc = self.svm.get_account(&addr).unwrap();
        let mut bet = escrow::Bet::try_deserialize(&mut acc.data.as_slice()).unwrap();
        bet.status = status;
        let mut out = Vec::with_capacity(acc.data.len());
        anchor_lang::AccountSerialize::try_serialize(&bet, &mut out).unwrap();
        acc.data[..out.len()].copy_from_slice(&out);
        self.svm.set_account(addr, acc).unwrap();
    }

    // ---------- transactions ----------

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        fee_payer: &Keypair,
        signers: &[&Keypair],
    ) -> SendResult {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&fee_payer.pubkey()), &blockhash);
        let keys: Vec<Pubkey> = msg.account_keys.clone();
        let mut all: Vec<&Keypair> = vec![fee_payer];
        for k in signers {
            if !all.iter().any(|x| x.pubkey() == k.pubkey()) {
                all.push(k);
            }
        }
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map(|meta| Sent { meta, keys })
    }

    // ---------- instruction builders ----------

    pub fn ix_initialize_config(&self, admin: Pubkey, args: &InitConfigArgs) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::InitializeConfig {
                admin,
                config: config_pda(),
                escrow_program: escrow::ID,
                program_data: program_data_address(&escrow::ID),
                system_program: system_program::ID,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::InitializeConfig { args: args.clone() }.data(),
        }
    }

    pub fn initialize_config(&mut self, args: &InitConfigArgs) -> SendResult {
        let ix = self.ix_initialize_config(self.admin.pubkey(), args);
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &admin, &[])
    }

    pub fn ix_update_config(&self, admin: Pubkey, args: &UpdateConfigArgs) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::UpdateConfig {
                admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::UpdateConfig { args: args.clone() }.data(),
        }
    }

    pub fn update_config(&mut self, args: &UpdateConfigArgs) -> SendResult {
        let ix = self.ix_update_config(self.admin.pubkey(), args);
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &admin, &[])
    }

    /// 5/5 USDC, A vs B, `accept_deadline = now + 300`.
    pub fn default_create(&self, id: [u8; 16]) -> (CreateArgs, CreateAccts) {
        let args = CreateArgs {
            bet_id: id,
            party_b: self.b.pubkey(),
            stake_a: USDC_5,
            stake_b: USDC_5,
            terms_hash: TERMS,
            accept_deadline: self.now() + 300,
        };
        let accts = CreateAccts {
            payer: self.s.pubkey(),
            party_a: self.a.pubkey(),
            config: config_pda(),
            mint: self.usdc,
            bet: bet_pda(&id).0,
            vault: vault_pda(&id).0,
            party_a_token: self.a_token,
            token_program: CLASSIC_TOKEN,
        };
        (args, accts)
    }

    pub fn ix_create_bet(&self, args: &CreateArgs, accts: &CreateAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::CreateBet {
                payer: accts.payer,
                party_a: accts.party_a,
                config: accts.config,
                mint: accts.mint,
                bet: accts.bet,
                vault: accts.vault,
                party_a_token: accts.party_a_token,
                token_program: accts.token_program,
                system_program: system_program::ID,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::CreateBet {
                bet_id: args.bet_id,
                party_b: args.party_b,
                stake_a: args.stake_a,
                stake_b: args.stake_b,
                terms_hash: args.terms_hash,
                accept_deadline: args.accept_deadline,
            }
            .data(),
        }
    }

    /// Sends `create_bet` alone (sequential-fallback shape), signed by S + A.
    pub fn create_bet(&mut self, args: &CreateArgs, accts: &CreateAccts) -> SendResult {
        let ix = self.ix_create_bet(args, accts);
        let (s, a) = (self.s.insecure_clone(), self.a.insecure_clone());
        self.send(&[ix], &s, &[&a])
    }

    pub fn default_accept(&self, c: &CreateArgs, ca: &CreateAccts) -> (AcceptArgs, AcceptAccts) {
        let args = AcceptArgs {
            expected_terms_hash: c.terms_hash,
            expected_stake_a: c.stake_a,
            expected_stake_b: c.stake_b,
            expected_party_a: ca.party_a,
        };
        let accts = AcceptAccts {
            payer: self.s.pubkey(),
            party_b: c.party_b,
            config: config_pda(),
            bet: ca.bet,
            vault: ca.vault,
            mint: ca.mint,
            party_b_token: self.b_token,
            token_program: ca.token_program,
        };
        (args, accts)
    }

    pub fn ix_accept_bet(&self, args: &AcceptArgs, accts: &AcceptAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::AcceptBet {
                payer: accts.payer,
                party_b: accts.party_b,
                config: accts.config,
                bet: accts.bet,
                vault: accts.vault,
                mint: accts.mint,
                party_b_token: accts.party_b_token,
                token_program: accts.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::AcceptBet {
                expected_terms_hash: args.expected_terms_hash,
                expected_stake_a: args.expected_stake_a,
                expected_stake_b: args.expected_stake_b,
                expected_party_a: args.expected_party_a,
            }
            .data(),
        }
    }

    /// Sends `accept_bet` alone, signed by S + `signer` (normally B).
    pub fn accept_bet_as(
        &mut self,
        args: &AcceptArgs,
        accts: &AcceptAccts,
        signer: &Keypair,
    ) -> SendResult {
        let ix = self.ix_accept_bet(args, accts);
        let s = self.s.insecure_clone();
        self.send(&[ix], &s, &[signer])
    }

    pub fn accept_bet(&mut self, args: &AcceptArgs, accts: &AcceptAccts) -> SendResult {
        let b = self.b.insecure_clone();
        self.accept_bet_as(args, accts, &b)
    }

    /// Default create (5/5) for `id`, asserted ok. Returns the args/accounts used.
    pub fn open_bet(&mut self, id: [u8; 16]) -> (CreateArgs, CreateAccts) {
        let (c, ca) = self.default_create(id);
        self.create_bet(&c, &ca).expect("create_bet");
        (c, ca)
    }
}

pub fn set_upgrade_authority(svm: &mut LiteSVM, program_id: &Pubkey, authority: Option<Pubkey>) {
    let pd = program_data_address(program_id);
    let mut acc = svm.get_account(&pd).expect("programdata exists");
    // UpgradeableLoaderState::ProgramData = tag u32 (3) | slot u64 | Option<Pubkey> (1 + 32)
    assert_eq!(&acc.data[0..4], &3u32.to_le_bytes());
    match authority {
        Some(k) => {
            acc.data[12] = 1;
            acc.data[13..45].copy_from_slice(k.as_ref());
        }
        None => {
            acc.data[12] = 0;
            acc.data[13..45].fill(0);
        }
    }
    svm.set_account(pd, acc).unwrap();
}

pub fn solana_account(lamports: u64, data: Vec<u8>, owner: Pubkey) -> solana_account::Account {
    solana_account::Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// Flip an account meta to non-signer (a pubkey passed but not signing).
pub fn unsign(ix: &mut Instruction, key: &Pubkey) {
    for m in ix.accounts.iter_mut() {
        if m.pubkey == *key {
            m.is_signer = false;
        }
    }
}

pub fn meta(pubkey: Pubkey, signer: bool, writable: bool) -> AccountMeta {
    AccountMeta {
        pubkey,
        is_signer: signer,
        is_writable: writable,
    }
}

/// Program-level error code of a failed tx (custom error from the escrow or Anchor).
pub fn custom_code(res: &SendResult) -> Option<u32> {
    match res {
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
pub fn assert_err(res: &SendResult, code: u32) {
    match res {
        Ok(_) => panic!("expected error {code}, tx succeeded"),
        Err(f) => {
            assert_eq!(
                custom_code(res),
                Some(code),
                "expected custom error {code}, got {:?}\nlogs:\n{}",
                f.err,
                f.meta.logs.join("\n")
            );
        }
    }
}

/// Like `assert_err`, and also pins which top-level instruction failed.
#[track_caller]
pub fn assert_err_at(res: &SendResult, ix: u8, code: u32) {
    let f = res.as_ref().err().expect("expected failure, tx succeeded");
    assert_eq!(
        f.err,
        TransactionError::InstructionError(ix, InstructionError::Custom(code)),
        "logs:\n{}",
        f.meta.logs.join("\n")
    );
}

#[track_caller]
pub fn assert_escrow_err(res: &SendResult, e: escrow::EscrowError) {
    assert_err(res, err_code(e));
}

#[track_caller]
pub fn assert_ok(res: &SendResult) -> &Sent {
    match res {
        Ok(s) => s,
        Err(f) => panic!("tx failed: {:?}\nlogs:\n{}", f.err, f.meta.logs.join("\n")),
    }
}

/// System "already in use" surfaces as InstructionError::Custom(0) from the System program
/// (SystemError::AccountAlreadyInUse) during Anchor's `init`.
#[track_caller]
pub fn assert_already_in_use(res: &SendResult) {
    let f = res.as_ref().err().expect("expected failure");
    let logs = f.meta.logs.join("\n");
    assert!(
        logs.contains("already in use"),
        "expected 'already in use', got {:?}\n{}",
        f.err,
        logs
    );
    assert_eq!(
        custom_code(res),
        Some(0),
        "SystemError::AccountAlreadyInUse = 0"
    );
}

/// Decode every `emit_cpi!` event of type `T` from the tx's inner instructions. An event is an
/// inner ix whose program is the escrow, whose data starts with EVENT_IX_TAG_LE, and whose
/// first account is the event authority (ESCROW §7.1 filter rule 2).
pub fn events<T: AnchorDeserialize + Discriminator>(sent: &Sent) -> Vec<T> {
    let ea = event_authority();
    let mut out = vec![];
    for group in &sent.meta.inner_instructions {
        for inner in group {
            let ci = &inner.instruction;
            let program = sent.keys[ci.program_id_index as usize];
            if program != escrow::ID {
                continue;
            }
            let data = &ci.data;
            if data.len() < 16 || &data[..8] != anchor_lang::event::EVENT_IX_TAG_LE {
                continue;
            }
            if ci.accounts.first().map(|i| sent.keys[*i as usize]) != Some(ea) {
                continue;
            }
            if &data[8..16] != T::DISCRIMINATOR {
                continue;
            }
            out.push(T::try_from_slice(&data[16..]).expect("event decodes"));
        }
    }
    out
}

/// Count all escrow events (any type) in the tx.
pub fn event_count(sent: &Sent) -> usize {
    sent.meta
        .inner_instructions
        .iter()
        .flatten()
        .filter(|i| {
            sent.keys[i.instruction.program_id_index as usize] == escrow::ID
                && i.instruction
                    .data
                    .starts_with(anchor_lang::event::EVENT_IX_TAG_LE)
        })
        .count()
}

#[track_caller]
pub fn assert_no_log_truncation(sent: &Sent) {
    assert!(!sent.meta.logs.iter().any(|l| l.contains("Log truncated")));
}

// =========================================================================================
// D1: ruling, terminal paths and close_bet (ESCROW §5.2). Fee payer is always S unless a test
// builds its own transaction with `Env::send`.
// =========================================================================================

/// Payout account set (P), ESCROW §5.2: `cancel_open_bet`, `concede`, `resolve_appeal`,
/// `finalize`, `timeout_refund`. A destination set to `None` is omitted (the generated client
/// passes the escrow program ID as the placeholder). The instruction's own signer (canceller,
/// party, appeal_authority) is an argument of its `ix_*` builder, not a field here.
#[derive(Clone, Debug)]
pub struct PayoutAccts {
    pub payer: Pubkey,
    pub bet: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub party_a_token: Option<Pubkey>,
    pub party_b_token: Option<Pubkey>,
    pub token_program: Pubkey,
}

/// `resolve` accounts.
#[derive(Clone, Debug)]
pub struct ResolveAccts {
    pub payer: Pubkey,
    pub judge_authority: Pubkey,
    pub bet: Pubkey,
}

/// `appeal` accounts.
#[derive(Clone, Debug)]
pub struct AppealAccts {
    pub payer: Pubkey,
    pub appellant: Pubkey,
    pub bet: Pubkey,
}

/// `close_bet` accounts. `party_a_token` is required only when the vault is non-empty.
#[derive(Clone, Debug)]
pub struct CloseAccts {
    pub payer: Pubkey,
    pub bet: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub party_a_token: Option<Pubkey>,
    pub rent_payer: Pubkey,
    pub token_program: Pubkey,
}

/// The five token-moving instructions and their events (ESCROW §7.2 table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalKind {
    /// `cancel_open_bet` → `BetCancelled`, status `Cancelled`, outcome `Refund`.
    Cancelled,
    /// `concede` → `BetConceded`, status `Settled`.
    Conceded,
    /// `finalize` → `BetFinalized`, status `Settled`.
    Finalized,
    /// `resolve_appeal` → `AppealResolved`, status `Settled`.
    AppealResolved,
    /// `timeout_refund` → `BetRefunded`, status `Refunded`, outcome `Refund`.
    Refunded,
}

impl TerminalKind {
    pub fn final_status(self) -> BetStatus {
        match self {
            TerminalKind::Cancelled => BetStatus::Cancelled,
            TerminalKind::Refunded => BetStatus::Refunded,
            _ => BetStatus::Settled,
        }
    }
}

/// The common fields of the five terminal events (§7.2), decoded into one shape. The per-event
/// extras (`conceded_by`, `caller`, `original_outcome`, ...) are read with `events::<T>()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalEvent {
    pub kind: TerminalKind,
    pub bet_id: [u8; 16],
    pub final_status: BetStatus,
    pub outcome: Outcome,
    pub mint: Pubkey,
    pub party_a: Pubkey,
    pub party_b: Pubkey,
    pub party_a_token: Pubkey,
    pub party_b_token: Pubkey,
    pub to_a: u64,
    pub to_b: u64,
    pub ts: i64,
}

macro_rules! to_terminal {
    ($kind:expr, $e:expr) => {
        TerminalEvent {
            kind: $kind,
            bet_id: $e.bet_id,
            final_status: $e.final_status,
            outcome: $e.outcome,
            mint: $e.mint,
            party_a: $e.party_a,
            party_b: $e.party_b,
            party_a_token: $e.party_a_token,
            party_b_token: $e.party_b_token,
            to_a: $e.to_a,
            to_b: $e.to_b,
            ts: $e.ts,
        }
    };
}

/// Every terminal event in the tx (any of the five types), in emission order per type.
pub fn terminal_events(sent: &Sent) -> Vec<TerminalEvent> {
    let mut out = vec![];
    for e in events::<BetCancelled>(sent) {
        out.push(to_terminal!(TerminalKind::Cancelled, e));
    }
    for e in events::<BetConceded>(sent) {
        out.push(to_terminal!(TerminalKind::Conceded, e));
    }
    for e in events::<BetFinalized>(sent) {
        out.push(to_terminal!(TerminalKind::Finalized, e));
    }
    for e in events::<AppealResolved>(sent) {
        out.push(to_terminal!(TerminalKind::AppealResolved, e));
    }
    for e in events::<BetRefunded>(sent) {
        out.push(to_terminal!(TerminalKind::Refunded, e));
    }
    out
}

/// §6 math as the program computes it (`escrow::payout::compute_payout`).
pub fn expected_payout(kind: PayoutKind, stake_a: u64, v: u64) -> (u64, u64) {
    compute_payout(kind, stake_a, v)
}

impl Env {
    // ---------- time and state ----------

    /// Move the clock by `secs` (may be negative, TM-T2).
    pub fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_now(t);
    }

    pub fn warp_to_accept_deadline(&mut self, id: &[u8; 16]) {
        let t = self.bet(id).accept_deadline;
        self.set_now(t);
    }

    pub fn warp_to_resolve_deadline(&mut self, id: &[u8; 16]) {
        let t = self.bet(id).resolve_deadline;
        self.set_now(t);
    }

    pub fn warp_to_appeal_deadline(&mut self, id: &[u8; 16]) {
        let t = self.bet(id).appeal_deadline;
        self.set_now(t);
    }

    pub fn warp_to_appeal_resolve_deadline(&mut self, id: &[u8; 16]) {
        let t = self.bet(id).appeal_resolve_deadline;
        self.set_now(t);
    }

    /// The Bet, or `None` once closed.
    pub fn try_bet(&self, id: &[u8; 16]) -> Option<Bet> {
        let acc = self.svm.get_account(&bet_pda(id).0)?;
        if acc.lamports == 0 || acc.data.len() < 8 {
            return None;
        }
        Bet::try_deserialize(&mut acc.data.as_slice()).ok()
    }

    /// Token balance, or `None` if the account doesn't exist (closed vault, omitted ATA).
    pub fn try_token_balance(&self, addr: &Pubkey) -> Option<u64> {
        let acc = self.svm.get_account(addr)?;
        if acc.lamports == 0 || acc.data.len() < 165 {
            return None;
        }
        spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165])
            .ok()
            .map(|a| a.amount)
    }

    /// SPL `owner` (authority) field of a token account.
    pub fn token_owner(&self, addr: &Pubkey) -> Pubkey {
        let acc = self.svm.get_account(addr).expect("token account exists");
        spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165])
            .unwrap()
            .owner
    }

    /// SPL `mint` field of a token account.
    pub fn token_mint(&self, addr: &Pubkey) -> Pubkey {
        let acc = self.svm.get_account(addr).expect("token account exists");
        spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165])
            .unwrap()
            .mint
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let acc = self.svm.get_account(mint).expect("mint exists");
        spl_token_2022::state::Mint::unpack_from_slice(&acc.data[..82])
            .unwrap()
            .supply
    }

    /// The program that owns `mint` (classic SPL Token or Token-2022).
    pub fn token_program_of(&self, mint: &Pubkey) -> Pubkey {
        self.svm
            .get_account(mint)
            .map(|a| a.owner)
            .unwrap_or(CLASSIC_TOKEN)
    }

    /// Overwrite a token account's `amount` (forced states such as T8's `V < stake_a`).
    pub fn set_token_amount(&mut self, addr: Pubkey, units: u64) {
        let mut acc = self.svm.get_account(&addr).unwrap();
        let mut ta = spl_token_2022::state::Account::unpack_from_slice(&acc.data[..165]).unwrap();
        ta.amount = units;
        ta.pack_into_slice(&mut acc.data[..165]);
        self.svm.set_account(addr, acc).unwrap();
    }

    /// Mallory sends `units` of USDC straight to the bet's vault with a real SPL transfer
    /// (unsolicited donation: M3, A12, L5, TM-L5).
    pub fn donate_to_vault(&mut self, id: &[u8; 16], units: u64) -> SendResult {
        let (vault, mint) = (vault_pda(id).0, self.usdc);
        let (from, m) = (self.mallory_token, self.mallory.insecure_clone());
        self.transfer_tokens(from, &m, vault, mint, units, CLASSIC_TOKEN)
    }

    /// The keypair that loses `outcome` per the §4 table (may concede / appeal). For Split and
    /// Refund both parties may appeal; this returns A.
    pub fn loser(&self, outcome: Outcome) -> Keypair {
        match outcome {
            Outcome::PartyA => self.b.insecure_clone(),
            _ => self.a.insecure_clone(),
        }
    }

    /// The keypair that wins `outcome` (A for Split / Refund, which have no winner).
    pub fn winner(&self, outcome: Outcome) -> Keypair {
        match outcome {
            Outcome::PartyB => self.b.insecure_clone(),
            _ => self.a.insecure_clone(),
        }
    }

    // ---------- account fillers ----------

    /// Payout set for `id`: payer S, PDAs from `id`, the bet's stored mint and its token program,
    /// and both party destinations = A's / B's USDC accounts when the bet's mint is `usdc`
    /// (`None` otherwise: set them yourself for a Token-2022 bet).
    pub fn default_payout(&self, id: &[u8; 16]) -> PayoutAccts {
        let mint = self.try_bet(id).map(|b| b.mint).unwrap_or(self.usdc);
        let usdc = mint == self.usdc;
        PayoutAccts {
            payer: self.s.pubkey(),
            bet: bet_pda(id).0,
            vault: vault_pda(id).0,
            mint,
            party_a_token: usdc.then_some(self.a_token),
            party_b_token: usdc.then_some(self.b_token),
            token_program: self.token_program_of(&mint),
        }
    }

    /// `default_payout` with both destinations omitted.
    pub fn bare_payout(&self, id: &[u8; 16]) -> PayoutAccts {
        PayoutAccts {
            party_a_token: None,
            party_b_token: None,
            ..self.default_payout(id)
        }
    }

    /// `close_bet` accounts for `id`: payer S, `rent_payer` = the stored `bet.rent_payer`
    /// (S if the bet is gone), and NO `party_a_token` (the normal, empty-vault case).
    pub fn default_close(&self, id: &[u8; 16]) -> CloseAccts {
        let bet = self.try_bet(id);
        let mint = bet.as_ref().map(|b| b.mint).unwrap_or(self.usdc);
        CloseAccts {
            payer: self.s.pubkey(),
            bet: bet_pda(id).0,
            vault: vault_pda(id).0,
            mint,
            party_a_token: None,
            rent_payer: bet.map(|b| b.rent_payer).unwrap_or(self.s.pubkey()),
            token_program: self.token_program_of(&mint),
        }
    }

    pub fn default_resolve(&self, id: &[u8; 16]) -> ResolveAccts {
        ResolveAccts {
            payer: self.s.pubkey(),
            judge_authority: self.judge.pubkey(),
            bet: bet_pda(id).0,
        }
    }

    pub fn default_appeal(&self, id: &[u8; 16], appellant: Pubkey) -> AppealAccts {
        AppealAccts {
            payer: self.s.pubkey(),
            appellant,
            bet: bet_pda(id).0,
        }
    }

    // ---------- D1 instruction builders ----------

    pub fn ix_cancel_open_bet(&self, canceller: Pubkey, p: &PayoutAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::CancelOpenBet {
                payer: p.payer,
                canceller,
                bet: p.bet,
                vault: p.vault,
                mint: p.mint,
                party_a_token: p.party_a_token,
                party_b_token: p.party_b_token,
                token_program: p.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::CancelOpenBet {}.data(),
        }
    }

    pub fn ix_resolve(
        &self,
        r: &ResolveAccts,
        outcome: Outcome,
        evidence_hash: [u8; 32],
        ruling_hash: [u8; 32],
    ) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Resolve {
                payer: r.payer,
                judge_authority: r.judge_authority,
                bet: r.bet,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::Resolve {
                outcome,
                evidence_hash,
                ruling_hash,
            }
            .data(),
        }
    }

    pub fn ix_concede(&self, party: Pubkey, p: &PayoutAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Concede {
                payer: p.payer,
                party,
                bet: p.bet,
                vault: p.vault,
                mint: p.mint,
                party_a_token: p.party_a_token,
                party_b_token: p.party_b_token,
                token_program: p.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::Concede {}.data(),
        }
    }

    pub fn ix_appeal(&self, a: &AppealAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Appeal {
                payer: a.payer,
                appellant: a.appellant,
                bet: a.bet,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::Appeal {}.data(),
        }
    }

    pub fn ix_resolve_appeal(
        &self,
        appeal_authority: Pubkey,
        p: &PayoutAccts,
        final_outcome: Outcome,
        appeal_ruling_hash: [u8; 32],
    ) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::ResolveAppeal {
                payer: p.payer,
                appeal_authority,
                bet: p.bet,
                vault: p.vault,
                mint: p.mint,
                party_a_token: p.party_a_token,
                party_b_token: p.party_b_token,
                token_program: p.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::ResolveAppeal {
                final_outcome,
                appeal_ruling_hash,
            }
            .data(),
        }
    }

    pub fn ix_finalize(&self, p: &PayoutAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::Finalize {
                payer: p.payer,
                bet: p.bet,
                vault: p.vault,
                mint: p.mint,
                party_a_token: p.party_a_token,
                party_b_token: p.party_b_token,
                token_program: p.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::Finalize {}.data(),
        }
    }

    pub fn ix_timeout_refund(&self, p: &PayoutAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::TimeoutRefund {
                payer: p.payer,
                bet: p.bet,
                vault: p.vault,
                mint: p.mint,
                party_a_token: p.party_a_token,
                party_b_token: p.party_b_token,
                token_program: p.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::TimeoutRefund {}.data(),
        }
    }

    pub fn ix_close_bet(&self, c: &CloseAccts) -> Instruction {
        Instruction {
            program_id: escrow::ID,
            accounts: escrow::accounts::CloseBet {
                payer: c.payer,
                bet: c.bet,
                vault: c.vault,
                mint: c.mint,
                party_a_token: c.party_a_token,
                rent_payer: c.rent_payer,
                token_program: c.token_program,
                event_authority: event_authority(),
                program: escrow::ID,
            }
            .to_account_metas(None),
            data: escrow::instruction::CloseBet {}.data(),
        }
    }

    // ---------- D1 senders (fee payer S) ----------

    /// Send `ixs` with S as fee payer plus `signers`.
    pub fn send_s(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> SendResult {
        let s = self.s.insecure_clone();
        self.send(ixs, &s, signers)
    }

    /// `[terminal_ix, close_bet(default_close(id))]` in ONE tx, S as fee payer (§5.0 step 4).
    /// `default_close` is computed before sending, so `rent_payer` is the stored one.
    pub fn send_bundled(
        &mut self,
        id: &[u8; 16],
        terminal_ix: Instruction,
        signers: &[&Keypair],
    ) -> SendResult {
        let close = self.ix_close_bet(&self.default_close(id));
        self.send_s(&[terminal_ix, close], signers)
    }

    pub fn cancel_open_bet(&mut self, id: &[u8; 16], canceller: &Keypair) -> SendResult {
        let ix = self.ix_cancel_open_bet(canceller.pubkey(), &self.default_payout(id));
        self.send_s(&[ix], &[canceller])
    }

    pub fn cancel_open_bet_bundled(&mut self, id: &[u8; 16], canceller: &Keypair) -> SendResult {
        let ix = self.ix_cancel_open_bet(canceller.pubkey(), &self.default_payout(id));
        self.send_bundled(id, ix, &[canceller])
    }

    /// `resolve` signed by J with `EVIDENCE` / `RULING`.
    pub fn resolve(&mut self, id: &[u8; 16], outcome: Outcome) -> SendResult {
        let j = self.judge.insecure_clone();
        self.resolve_as(id, &j, outcome, EVIDENCE, RULING)
    }

    pub fn resolve_as(
        &mut self,
        id: &[u8; 16],
        judge: &Keypair,
        outcome: Outcome,
        evidence_hash: [u8; 32],
        ruling_hash: [u8; 32],
    ) -> SendResult {
        let mut r = self.default_resolve(id);
        r.judge_authority = judge.pubkey();
        let ix = self.ix_resolve(&r, outcome, evidence_hash, ruling_hash);
        self.send_s(&[ix], &[judge])
    }

    pub fn concede(&mut self, id: &[u8; 16], party: &Keypair) -> SendResult {
        let ix = self.ix_concede(party.pubkey(), &self.default_payout(id));
        self.send_s(&[ix], &[party])
    }

    pub fn concede_bundled(&mut self, id: &[u8; 16], party: &Keypair) -> SendResult {
        let ix = self.ix_concede(party.pubkey(), &self.default_payout(id));
        self.send_bundled(id, ix, &[party])
    }

    pub fn appeal(&mut self, id: &[u8; 16], appellant: &Keypair) -> SendResult {
        let ix = self.ix_appeal(&self.default_appeal(id, appellant.pubkey()));
        self.send_s(&[ix], &[appellant])
    }

    /// `resolve_appeal` signed by AP with `APPEAL_RULING`.
    pub fn resolve_appeal(&mut self, id: &[u8; 16], final_outcome: Outcome) -> SendResult {
        let ap = self.appeal.insecure_clone();
        self.resolve_appeal_as(id, &ap, final_outcome, APPEAL_RULING)
    }

    pub fn resolve_appeal_bundled(&mut self, id: &[u8; 16], final_outcome: Outcome) -> SendResult {
        let ap = self.appeal.insecure_clone();
        let ix = self.ix_resolve_appeal(
            ap.pubkey(),
            &self.default_payout(id),
            final_outcome,
            APPEAL_RULING,
        );
        self.send_bundled(id, ix, &[&ap])
    }

    pub fn resolve_appeal_as(
        &mut self,
        id: &[u8; 16],
        appeal_authority: &Keypair,
        final_outcome: Outcome,
        appeal_ruling_hash: [u8; 32],
    ) -> SendResult {
        let ix = self.ix_resolve_appeal(
            appeal_authority.pubkey(),
            &self.default_payout(id),
            final_outcome,
            appeal_ruling_hash,
        );
        self.send_s(&[ix], &[appeal_authority])
    }

    pub fn finalize(&mut self, id: &[u8; 16]) -> SendResult {
        let ix = self.ix_finalize(&self.default_payout(id));
        self.send_s(&[ix], &[])
    }

    pub fn finalize_bundled(&mut self, id: &[u8; 16]) -> SendResult {
        let ix = self.ix_finalize(&self.default_payout(id));
        self.send_bundled(id, ix, &[])
    }

    pub fn timeout_refund(&mut self, id: &[u8; 16]) -> SendResult {
        let ix = self.ix_timeout_refund(&self.default_payout(id));
        self.send_s(&[ix], &[])
    }

    pub fn timeout_refund_bundled(&mut self, id: &[u8; 16]) -> SendResult {
        let ix = self.ix_timeout_refund(&self.default_payout(id));
        self.send_bundled(id, ix, &[])
    }

    /// Standalone `close_bet` with `default_close(id)`.
    pub fn close_bet(&mut self, id: &[u8; 16]) -> SendResult {
        let ix = self.ix_close_bet(&self.default_close(id));
        self.send_s(&[ix], &[])
    }

    // ---------- state drivers (each asserts every step ok) ----------

    /// 5/5 bet → `Locked` via the atomic shape: `[create_bet, accept_bet]` in one tx (S, A, B).
    pub fn locked_bet(&mut self, id: [u8; 16]) -> (CreateArgs, CreateAccts) {
        self.locked_bet_with(id, USDC_5, USDC_5)
    }

    /// `locked_bet` with custom stakes (each ≤ `MAX_STAKE`; A and B hold `FUNDED`).
    pub fn locked_bet_with(
        &mut self,
        id: [u8; 16],
        stake_a: u64,
        stake_b: u64,
    ) -> (CreateArgs, CreateAccts) {
        let (mut c, ca) = self.default_create(id);
        c.stake_a = stake_a;
        c.stake_b = stake_b;
        let (aa, acc) = self.default_accept(&c, &ca);
        let ixs = [self.ix_create_bet(&c, &ca), self.ix_accept_bet(&aa, &acc)];
        let (a, b) = (self.a.insecure_clone(), self.b.insecure_clone());
        assert_ok(&self.send_s(&ixs, &[&a, &b]));
        assert_eq!(self.bet(&id).status, BetStatus::Locked);
        (c, ca)
    }

    /// 5/5 bet → `Resolved` with `outcome` (J, `EVIDENCE`, `RULING`) at the current clock.
    pub fn resolved_bet(&mut self, id: [u8; 16], outcome: Outcome) -> (CreateArgs, CreateAccts) {
        self.resolved_bet_with(id, USDC_5, USDC_5, outcome)
    }

    pub fn resolved_bet_with(
        &mut self,
        id: [u8; 16],
        stake_a: u64,
        stake_b: u64,
        outcome: Outcome,
    ) -> (CreateArgs, CreateAccts) {
        let r = self.locked_bet_with(id, stake_a, stake_b);
        assert_ok(&self.resolve(&id, outcome));
        assert_eq!(self.bet(&id).status, BetStatus::Resolved);
        r
    }

    /// 5/5 bet → `Resolved(outcome)` → `Appealed` by `loser(outcome)` (A for Split / Refund).
    pub fn appealed_bet(&mut self, id: [u8; 16], outcome: Outcome) -> (CreateArgs, CreateAccts) {
        let appellant = self.loser(outcome);
        self.appealed_bet_with(id, USDC_5, USDC_5, outcome, &appellant)
    }

    pub fn appealed_bet_with(
        &mut self,
        id: [u8; 16],
        stake_a: u64,
        stake_b: u64,
        outcome: Outcome,
        appellant: &Keypair,
    ) -> (CreateArgs, CreateAccts) {
        let r = self.resolved_bet_with(id, stake_a, stake_b, outcome);
        assert_ok(&self.appeal(&id, appellant));
        assert_eq!(self.bet(&id).status, BetStatus::Appealed);
        r
    }

    /// 5/5 bet → `Resolved(outcome)` → clock at `appeal_deadline` → STANDALONE `finalize`.
    /// The Bet persists as `Settled` with an empty vault (input for `close_bet` rows).
    pub fn settled_bet(&mut self, id: [u8; 16], outcome: Outcome) -> (CreateArgs, CreateAccts) {
        let r = self.resolved_bet(id, outcome);
        self.warp_to_appeal_deadline(&id);
        assert_ok(&self.finalize(&id));
        assert_eq!(self.bet(&id).status, BetStatus::Settled);
        r
    }

    /// 5/5 bet → `Locked` → clock at `resolve_deadline` → STANDALONE `timeout_refund`.
    pub fn refunded_bet(&mut self, id: [u8; 16]) -> (CreateArgs, CreateAccts) {
        let r = self.locked_bet(id);
        self.warp_to_resolve_deadline(&id);
        assert_ok(&self.timeout_refund(&id));
        assert_eq!(self.bet(&id).status, BetStatus::Refunded);
        r
    }

    /// 5/5 `Open` bet → STANDALONE `cancel_open_bet` by A.
    pub fn cancelled_bet(&mut self, id: [u8; 16]) -> (CreateArgs, CreateAccts) {
        let r = self.open_bet(id);
        let a = self.a.insecure_clone();
        assert_ok(&self.cancel_open_bet(&id, &a));
        assert_eq!(self.bet(&id).status, BetStatus::Cancelled);
        r
    }
}

// =========================================================================================
// §9.1 global post-conditions
// =========================================================================================

/// Chain state captured right BEFORE a terminal (or close_bet) transaction.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub bet_id: [u8; 16],
    /// The Bet as it was before the tx.
    pub bet: Bet,
    pub bet_addr: Pubkey,
    pub vault_addr: Pubkey,
    /// `V = vault.amount`.
    pub v: u64,
    pub bet_lamports: u64,
    pub vault_lamports: u64,
    pub rent_payer_lamports: u64,
    pub supply: u64,
    /// Every tracked token account and its balance (`None` = doesn't exist).
    pub balances: Vec<(Pubkey, Option<u64>)>,
}

impl Snapshot {
    /// Tracks A's, B's and Mallory's USDC accounts.
    pub fn take(env: &Env, id: &[u8; 16]) -> Self {
        Self::take_with(env, id, &[])
    }

    /// Also tracks `extra` token accounts (fresh destinations, a second mint's accounts...).
    /// The post-condition helpers fail if a payout lands in an untracked account.
    pub fn take_with(env: &Env, id: &[u8; 16], extra: &[Pubkey]) -> Self {
        let bet = env.try_bet(id).expect("snapshot: bet exists");
        let (bet_addr, vault_addr) = (bet_pda(id).0, vault_pda(id).0);
        assert_rederives(&bet, &bet_addr, &vault_addr);
        let mut tracked = vec![env.a_token, env.b_token, env.mallory_token];
        for k in extra {
            if !tracked.contains(k) {
                tracked.push(*k);
            }
        }
        Snapshot {
            bet_id: *id,
            v: env.try_token_balance(&vault_addr).expect("snapshot: vault"),
            bet_lamports: env.sol(&bet_addr),
            vault_lamports: env.sol(&vault_addr),
            rent_payer_lamports: env.sol(&bet.rent_payer),
            supply: env.mint_supply(&bet.mint),
            balances: tracked
                .into_iter()
                .map(|k| (k, env.try_token_balance(&k)))
                .collect(),
            bet,
            bet_addr,
            vault_addr,
        }
    }

    /// Balance change of `addr` since the snapshot (`None` counts as 0).
    pub fn delta(&self, env: &Env, addr: &Pubkey) -> i128 {
        let before = self
            .balances
            .iter()
            .find(|(k, _)| k == addr)
            .unwrap_or_else(|| panic!("{addr} not tracked: use Snapshot::take_with"))
            .1
            .unwrap_or(0);
        i128::from(env.try_token_balance(addr).unwrap_or(0)) - i128::from(before)
    }
}

/// What a terminal transaction is expected to have done.
#[derive(Clone, Debug)]
pub struct ExpectTerminal {
    pub kind: TerminalKind,
    /// The outcome field of the terminal event (`Refund` for cancel / timeout).
    pub outcome: Outcome,
    pub to_a: u64,
    pub to_b: u64,
}

impl ExpectTerminal {
    pub fn new(kind: TerminalKind, outcome: Outcome, to_a: u64, to_b: u64) -> Self {
        ExpectTerminal {
            kind,
            outcome,
            to_a,
            to_b,
        }
    }

    /// Expected amounts computed from the snapshot's `stake_a` and `V` with the §6 formula.
    pub fn from_math(
        kind: TerminalKind,
        outcome: Outcome,
        payout: PayoutKind,
        before: &Snapshot,
    ) -> Self {
        let (to_a, to_b) = compute_payout(payout, before.bet.stake_a, before.v);
        Self::new(kind, outcome, to_a, to_b)
    }
}

/// I16: Bet and vault re-derive from the stored `bet_id` and bumps.
#[track_caller]
pub fn assert_rederives(bet: &Bet, bet_addr: &Pubkey, vault_addr: &Pubkey) {
    let b = Pubkey::create_program_address(&[BET_SEED, &bet.bet_id, &[bet.bump]], &escrow::ID);
    let v =
        Pubkey::create_program_address(&[VAULT_SEED, &bet.bet_id, &[bet.vault_bump]], &escrow::ID);
    assert_eq!(b.ok().as_ref(), Some(bet_addr), "I16: Bet re-derives");
    assert_eq!(v.ok().as_ref(), Some(vault_addr), "I16: vault re-derives");
}

/// The checks shared by both variants: one terminal event with the expected fields, money only
/// to party-owned accounts named by the event, `Δa + Δb == V`, supply unchanged, no truncation.
#[track_caller]
fn check_terminal_money(
    env: &Env,
    before: &Snapshot,
    sent: &Sent,
    exp: &ExpectTerminal,
) -> TerminalEvent {
    let bet = &before.bet;
    let evs = terminal_events(sent);
    assert_eq!(evs.len(), 1, "exactly one terminal event: {evs:?}");
    let ev = evs[0].clone();
    assert_eq!(ev.kind, exp.kind);
    assert_eq!(ev.bet_id, before.bet_id);
    assert_eq!(ev.final_status, exp.kind.final_status());
    assert_eq!(ev.outcome, exp.outcome);
    assert_eq!(ev.mint, bet.mint);
    assert_eq!((ev.party_a, ev.party_b), (bet.party_a, bet.party_b));
    assert_eq!((ev.to_a, ev.to_b), (exp.to_a, exp.to_b), "event amounts");
    assert_eq!(
        u128::from(ev.to_a) + u128::from(ev.to_b),
        u128::from(before.v),
        "to_a + to_b == V (I5)"
    );
    assert_eq!(ev.ts, env.now());

    // I1: each named destination is a token account of bet.mint owned by that party.
    for (dst, amt, party) in [
        (ev.party_a_token, ev.to_a, bet.party_a),
        (ev.party_b_token, ev.to_b, bet.party_b),
    ] {
        if amt == 0 {
            assert_eq!(dst, Pubkey::default(), "zero side names Pubkey::default()");
        } else {
            assert_ne!(dst, Pubkey::default());
            assert_eq!(env.token_owner(&dst), party, "I1: destination owner");
            assert_eq!(env.token_mint(&dst), bet.mint, "I1: destination mint");
        }
    }
    // Only the named accounts changed, by exactly the event amounts.
    for (k, _) in &before.balances {
        let mut want = 0i128;
        if *k == ev.party_a_token {
            want += i128::from(ev.to_a);
        }
        if *k == ev.party_b_token {
            want += i128::from(ev.to_b);
        }
        assert_eq!(before.delta(env, k), want, "balance delta of {k}");
    }
    for dst in [ev.party_a_token, ev.party_b_token] {
        if dst != Pubkey::default() {
            assert!(
                before.balances.iter().any(|(k, _)| *k == dst),
                "payout to untracked {dst}: use Snapshot::take_with"
            );
        }
    }
    assert_eq!(
        env.mint_supply(&bet.mint),
        before.supply,
        "supply unchanged"
    );
    assert_no_log_truncation(sent);
    ev
}

/// §9.1 post-conditions for a BUNDLED `[terminal ix, close_bet]` tx (e.g. from `*_bundled`):
/// the common money checks, plus exactly one `BetClosed` (2 escrow events in total) with
/// `residual_to_a == 0` and `rent_returned` = Bet + vault lamports before; Bet and vault gone;
/// `rent_payer` up by exactly `rent_returned` (net of the tx fee when it is also the fee payer,
/// and assuming the tx moved no other lamports of it). Returns the terminal event.
#[track_caller]
pub fn assert_terminal_postconditions_bundled(
    env: &Env,
    before: &Snapshot,
    sent: &Sent,
    exp: &ExpectTerminal,
) -> TerminalEvent {
    let ev = check_terminal_money(env, before, sent, exp);
    assert_eq!(event_count(sent), 2, "terminal event + BetClosed");
    let closed = events::<BetClosed>(sent);
    assert_eq!(closed.len(), 1);
    let c = &closed[0];
    assert_eq!(c.bet_id, before.bet_id);
    assert_eq!(c.final_status, exp.kind.final_status());
    assert_eq!(c.rent_payer, before.bet.rent_payer);
    assert_eq!(c.rent_returned, before.bet_lamports + before.vault_lamports);
    assert_eq!(c.residual_to_a, 0);
    assert_eq!(c.ts, env.now());
    assert_rent_returned(env, before, sent, c.rent_returned);
    ev
}

/// §9.1 post-conditions for a STANDALONE terminal tx (no `close_bet`): the common money checks,
/// exactly one escrow event, the Bet persists with the terminal status, re-derives (I16),
/// `vault.amount == 0`, and every terminal ix (plus `resolve` / `appeal`) on it now fails
/// `[InvalidStatus]` (I5). Those probes all fail, so they change nothing. Returns the event.
#[track_caller]
pub fn assert_terminal_postconditions_standalone(
    env: &mut Env,
    before: &Snapshot,
    sent: &Sent,
    exp: &ExpectTerminal,
) -> TerminalEvent {
    let ev = check_terminal_money(env, before, sent, exp);
    assert_eq!(event_count(sent), 1, "standalone: only the terminal event");
    let bet = env
        .try_bet(&before.bet_id)
        .expect("standalone: Bet persists");
    assert_eq!(bet.status, exp.kind.final_status());
    assert_rederives(&bet, &before.bet_addr, &before.vault_addr);
    assert_eq!(
        env.try_token_balance(&before.vault_addr),
        Some(0),
        "vault == 0"
    );
    // P8: a standalone terminal tx never touches rent_payer (beyond the fee, if it paid it).
    assert_eq!(
        i128::from(env.sol(&before.bet.rent_payer)) - i128::from(before.rent_payer_lamports),
        -fee_paid_by(sent, &before.bet.rent_payer),
        "standalone terminal ix moved rent_payer lamports"
    );
    assert_all_terminal_ixs_fail(env, &before.bet_id);
    ev
}

/// After a STANDALONE `close_bet` on a terminal bet (`before` taken while terminal): one
/// `BetClosed` with the right fields and `residual_to_a == expected_residual`; Bet and vault
/// gone; rent to `rent_payer` (net of fee if it paid); the residual landed only in A-owned
/// tracked accounts; supply unchanged. Returns the event.
#[track_caller]
pub fn assert_close_postconditions(
    env: &Env,
    before: &Snapshot,
    sent: &Sent,
    expected_residual: u64,
) -> BetClosed {
    assert_eq!(event_count(sent), 1, "close_bet: only BetClosed");
    let mut closed = events::<BetClosed>(sent);
    assert_eq!(closed.len(), 1);
    let c = closed.remove(0);
    assert_eq!(c.bet_id, before.bet_id);
    assert_eq!(c.final_status, before.bet.status);
    assert!(c.final_status.is_terminal());
    assert_eq!(c.rent_payer, before.bet.rent_payer);
    assert_eq!(c.rent_returned, before.bet_lamports + before.vault_lamports);
    assert_eq!(c.residual_to_a, expected_residual);
    assert_eq!(c.ts, env.now());
    assert_rent_returned(env, before, sent, c.rent_returned);
    let mut total = 0i128;
    for (k, _) in &before.balances {
        let d = before.delta(env, k);
        if d != 0 {
            assert_eq!(
                env.token_owner(k),
                before.bet.party_a,
                "residual goes to A only"
            );
            assert!(d > 0);
        }
        total += d;
    }
    assert_eq!(
        total,
        i128::from(expected_residual),
        "residual landed in tracked A accounts"
    );
    assert_eq!(env.mint_supply(&before.bet.mint), before.supply);
    assert_no_log_truncation(sent);
    c
}

/// Bet and vault are gone and `rent_payer` gained exactly `rent_returned` (minus the tx fee
/// when it was also the fee payer).
#[track_caller]
fn assert_rent_returned(env: &Env, before: &Snapshot, sent: &Sent, rent_returned: u64) {
    assert!(!env.exists(&before.bet_addr), "Bet closed");
    assert!(!env.exists(&before.vault_addr), "vault closed");
    let rp = before.bet.rent_payer;
    let fee = fee_paid_by(sent, &rp);
    assert_eq!(
        i128::from(env.sol(&rp)) - i128::from(before.rent_payer_lamports),
        i128::from(rent_returned) - fee,
        "rent_payer Δ == rent_returned − fee"
    );
}

/// The tx fee if `who` was the fee payer, else 0.
pub fn fee_paid_by(sent: &Sent, who: &Pubkey) -> i128 {
    if sent.keys.first() == Some(who) {
        i128::from(sent.meta.fee)
    } else {
        0
    }
}

/// Every instruction that requires a non-terminal status fails `[InvalidStatus]` on `id`:
/// cancel (A), resolve (J), concede (B), appeal (A), resolve_appeal (AP), finalize,
/// timeout_refund. Destinations are omitted so only the status check can fail.
#[track_caller]
pub fn assert_all_terminal_ixs_fail(env: &mut Env, id: &[u8; 16]) {
    let p = env.bare_payout(id);
    let (a, b, j, ap) = (
        env.a.insecure_clone(),
        env.b.insecure_clone(),
        env.judge.insecure_clone(),
        env.appeal.insecure_clone(),
    );
    let probes: Vec<(&str, Instruction, Keypair)> = vec![
        (
            "cancel_open_bet",
            env.ix_cancel_open_bet(a.pubkey(), &p),
            a.insecure_clone(),
        ),
        (
            "resolve",
            env.ix_resolve(&env.default_resolve(id), Outcome::PartyA, EVIDENCE, RULING),
            j,
        ),
        ("concede", env.ix_concede(b.pubkey(), &p), b),
        (
            "appeal",
            env.ix_appeal(&env.default_appeal(id, a.pubkey())),
            a.insecure_clone(),
        ),
        (
            "resolve_appeal",
            env.ix_resolve_appeal(ap.pubkey(), &p, Outcome::PartyA, APPEAL_RULING),
            ap,
        ),
        ("finalize", env.ix_finalize(&p), a.insecure_clone()),
        ("timeout_refund", env.ix_timeout_refund(&p), a),
    ];
    for (name, ix, signer) in probes {
        let needs_signer = ix.accounts.iter().any(|m| m.pubkey == signer.pubkey());
        let signers: Vec<&Keypair> = if needs_signer { vec![&signer] } else { vec![] };
        let res = env.send_s(&[ix], &signers);
        assert!(
            custom_code(&res) == Some(err_code(EscrowError::InvalidStatus)),
            "{name} on a terminal bet: expected InvalidStatus, got {:?}",
            res.as_ref().err().map(|f| &f.err)
        );
    }
}
