//! Shared LiteSVM harness for the ESCROW §9.2 matrix.

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
    BetStatus, Config, InitConfigArgs, UpdateConfigArgs, BET_SEED, CONFIG_SEED, VAULT_SEED,
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
