/**
 * QuickNode Streams filter for Verdict (CONTRACTS §12.5).
 *
 * Dataset: Solana `block`. Keeps successful transactions that mention
 * VERDICT_PROGRAM_ID, decodes their `Program data:` log lines (emitted while
 * the Verdict program is the innermost invoked program) into §9.5 events and
 * returns
 *   { stream: "verdict-devnet", events: [{signature, slot, block_time, index, name, data}] }
 * or null when a batch has no Verdict events (QuickNode then delivers nothing).
 *
 * Decoded encoding (§12.5): Pubkey → base58, [u8;32] → hex, u64/i64 → decimal
 * string, smaller ints → number, bool → boolean, [u8;8] → number array,
 * [u64;8] / Vec<u64> → decimal strings. This is a self-contained copy of the
 * engine's `decodeEvent` (no imports are available in the Streams runtime);
 * packages/backend/test/quicknode-filter.test.ts checks it against the engine
 * for every event.
 */

var VERDICT_PROGRAM_ID = 'dbqDmF6YtjPygXTvJD31CNADoLqiUG8pZgj1zpHaMye';
var STREAM_NAME = 'verdict-devnet';

/** sha256("event:<Name>")[0..8], hex. */
var EVENT_DISCRIMINATORS = {
  ProfileUpdated: 'baf83e627062a1fc',
  BetCreated: '20996947bc486b72',
  Funded: '43543858c00cc9b1',
  BetCancelled: '20b380b87dc16a68',
  BetStarted: '671f55ce06a39d69',
  EvidenceCommitted: 'adbb652726e51296',
  BetEnded: '49603a6113b50671',
  TracksPosted: '0cffc0730c7c7a0f',
  BiometricVerified: '68637bb16675c483',
  PreRuled: 'ff4d998bdff74418',
  Consented: 'dd27e06ffca4a774',
  Disputed: 'baeb5bd1945d98d9',
  Settled: 'e8d228118e7c91ee',
  Refunded: '236795f6c47bdd63',
};

/** Field order per §9.5. */
var EVENT_SCHEMAS = {
  ProfileUpdated: [['wallet', 'pubkey'], ['flags', 'u8']],
  BetCreated: [
    ['bet', 'pubkey'], ['creator', 'pubkey'], ['nonce', 'u64'], ['participants', 'vec_pubkey'], ['stakes', 'vec_u64'],
    ['side_b_mask', 'u8'], ['flags', 'u8'], ['program_hash', 'hash'], ['time_limit_s', 'u32'], ['fund_deadline', 'i64'],
  ],
  Funded: [
    ['bet', 'pubkey'], ['participant', 'pubkey'], ['participant_idx', 'u8'], ['amount', 'u64'], ['funded_mask', 'u8'],
    ['all_funded', 'bool'], ['calibration_hash', 'hash'],
  ],
  BetCancelled: [['bet', 'pubkey']],
  BetStarted: [['bet', 'pubkey'], ['beacon_slot', 'u64'], ['beacon_hash', 'hash'], ['started_at', 'i64'], ['n_witnesses', 'u8']],
  EvidenceCommitted: [['bet', 'pubkey'], ['seq', 'u32'], ['root', 'hash'], ['gap_mask', 'u8'], ['is_final', 'bool']],
  BetEnded: [['bet', 'pubkey'], ['evidence_root', 'hash'], ['ended_at', 'i64']],
  TracksPosted: [['bet', 'pubkey'], ['perception_root', 'hash'], ['tracks_hash', 'hash'], ['payload_len', 'u32']],
  BiometricVerified: [['bet', 'pubkey'], ['participant_idx', 'u8'], ['modality', 'u8'], ['frame', 'u32']],
  PreRuled: [
    ['bet', 'pubkey'], ['preruling', 'u8'], ['reason', 'u8'], ['winner_mask', 'u8'], ['leg_results', 'u8x8'], ['consent_deadline', 'i64'],
  ],
  Consented: [['bet', 'pubkey'], ['participant', 'pubkey'], ['consent_mask', 'u8']],
  Disputed: [['bet', 'pubkey'], ['disputer', 'pubkey'], ['reason', 'u8'], ['bond', 'u64']],
  Settled: [['bet', 'pubkey'], ['path', 'u8'], ['winner_mask', 'u8'], ['pot', 'u64'], ['payouts', 'u64x8']],
  Refunded: [['bet', 'pubkey'], ['reason', 'u8'], ['amounts', 'u64x8']],
};

// ---- encodings -------------------------------------------------------------------

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base64Decode(s) {
  var clean = s.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) throw new Error('base64');
  var out = [];
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    buf = (buf << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function base58Encode(bytes) {
  var digits = [0];
  for (var i = 0; i < bytes.length; i++) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  var s = '';
  for (var k = 0; k < bytes.length && bytes[k] === 0; k++) s += '1';
  for (var q = digits.length - 1; q >= 0; q--) s += B58[digits[q]];
  return s;
}

function hex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function Reader(bytes, off) {
  this.b = bytes;
  this.o = off;
}
Reader.prototype.take = function (n) {
  if (this.o + n > this.b.length) throw new Error('truncated');
  var out = this.b.slice(this.o, this.o + n);
  this.o += n;
  return out;
};
Reader.prototype.uint = function (n) {
  var v = BigInt(0);
  var x = this.take(n);
  for (var i = n - 1; i >= 0; i--) v = (v << BigInt(8)) | BigInt(x[i]);
  return v;
};
Reader.prototype.field = function (t) {
  switch (t) {
    case 'pubkey': return base58Encode(this.take(32));
    case 'hash': return hex(this.take(32));
    case 'u8': return this.take(1)[0];
    case 'u32': return Number(this.uint(4));
    case 'u64': return this.uint(8).toString();
    case 'i64': return BigInt.asIntN(64, this.uint(8)).toString();
    case 'bool': {
      var b = this.take(1)[0];
      if (b > 1) throw new Error('bool');
      return b === 1;
    }
    case 'vec_pubkey':
    case 'vec_u64': {
      var n = Number(this.uint(4));
      if (n > 255) throw new Error('vec too long');
      var out = [];
      for (var i = 0; i < n; i++) out.push(this.field(t === 'vec_pubkey' ? 'pubkey' : 'u64'));
      return out;
    }
    case 'u8x8': return this.take(8);
    case 'u64x8': {
      var a = [];
      for (var k = 0; k < 8; k++) a.push(this.uint(8).toString());
      return a;
    }
  }
  throw new Error('field type ' + t);
};

/** Decodes `disc ‖ borsh` (base64 string) → {name, data} or null. */
function decodeEventBase64(b64) {
  var bytes;
  try {
    bytes = base64Decode(b64);
  } catch (e) {
    return null;
  }
  if (bytes.length < 8) return null;
  var disc = hex(bytes.slice(0, 8));
  for (var name in EVENT_DISCRIMINATORS) {
    if (EVENT_DISCRIMINATORS[name] !== disc) continue;
    try {
      var r = new Reader(bytes, 8);
      var data = {};
      var schema = EVENT_SCHEMAS[name];
      for (var i = 0; i < schema.length; i++) data[schema[i][0]] = r.field(schema[i][1]);
      if (r.o !== bytes.length) return null;
      return { name: name, data: data };
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** Verdict events from one transaction's logs (innermost-program rule, like the backend's parseProgramLogs). */
function eventsFromLogs(logs, programId) {
  var stack = [];
  var out = [];
  for (var i = 0; i < logs.length; i++) {
    var line = logs[i];
    var inv = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (inv) {
      stack.push(inv[1]);
      continue;
    }
    if (/^Program (\S+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    var m = /^Program data: ([A-Za-z0-9+/=]+)\s*$/.exec(line);
    if (m && stack[stack.length - 1] === programId) {
      var ev = decodeEventBase64(m[1]);
      if (ev) out.push(ev);
    }
  }
  return out;
}

function accountKeysOf(tx) {
  var msg = tx && tx.transaction && tx.transaction.message;
  var keys = (msg && msg.accountKeys) || [];
  var out = [];
  for (var i = 0; i < keys.length; i++) out.push(typeof keys[i] === 'string' ? keys[i] : keys[i] && keys[i].pubkey);
  var loaded = tx && tx.meta && tx.meta.loadedAddresses;
  if (loaded) out = out.concat(loaded.writable || [], loaded.readonly || []);
  return out;
}

function mentionsProgram(tx, programId) {
  if (accountKeysOf(tx).indexOf(programId) >= 0) return true;
  var logs = (tx && tx.meta && tx.meta.logMessages) || [];
  for (var i = 0; i < logs.length; i++) if (logs[i].indexOf(programId) >= 0) return true;
  return false;
}

/** Events of one block (getBlock JSON shape). `fallbackSlot` when the block omits `slot`. */
function blockEvents(block, programId, fallbackSlot) {
  var events = [];
  if (!block || !block.transactions) return events;
  var slot = typeof block.slot === 'number' ? block.slot : fallbackSlot;
  var blockTime = typeof block.blockTime === 'number' ? block.blockTime : null;
  for (var t = 0; t < block.transactions.length; t++) {
    var tx = block.transactions[t];
    if (!tx || !tx.meta || tx.meta.err) continue;
    if (!mentionsProgram(tx, programId)) continue;
    var sig = tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0];
    if (!sig) continue;
    var evs = eventsFromLogs(tx.meta.logMessages || [], programId);
    for (var i = 0; i < evs.length; i++) {
      events.push({ signature: sig, slot: slot, block_time: blockTime, index: i, name: evs[i].name, data: evs[i].data });
    }
  }
  return events;
}

/** QuickNode Streams entry point. */
function main(stream) {
  var data = stream && stream.data;
  var blocks = Array.isArray(data) ? data : data ? [data] : [];
  var meta = (stream && stream.metadata) || {};
  var start = typeof meta.batch_start_range === 'number' ? meta.batch_start_range : null;
  var events = [];
  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b];
    var fallback = start !== null ? start + b : block && typeof block.parentSlot === 'number' ? block.parentSlot + 1 : 0;
    events = events.concat(blockEvents(block, VERDICT_PROGRAM_ID, fallback));
  }
  if (events.length === 0) return null;
  return { stream: STREAM_NAME, events: events };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { main: main, decodeEventBase64: decodeEventBase64, eventsFromLogs: eventsFromLogs, blockEvents: blockEvents, VERDICT_PROGRAM_ID: VERDICT_PROGRAM_ID, EVENT_DISCRIMINATORS: EVENT_DISCRIMINATORS };
}
