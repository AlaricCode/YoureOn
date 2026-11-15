// QuickNode Streams filter for the You're On escrow (API-CONTRACT §5.2, ESCROW §7.1 rules 1-5).
//
// Dataset "block" (getBlock objects, encoding json or jsonParsed). Emits one envelope per batch
// with >= 1 matching event, else null (QuickNode then sends nothing).
//
// Rules:
//   1. drop transactions with meta.err != null (a failed tx still records the inner instructions
//      that ran before the failure);
//   2. an event is an INNER instruction whose program (resolved through accountKeys +
//      meta.loadedAddresses) == CONFIG.programId, whose data starts with the Anchor event-ix tag,
//      and whose first account == CONFIG.eventAuthority (only our program can sign as that PDA);
//   3. top-level instructions are never decoded;
//   4. there is no emit! / "Program data:" log-path decoder;
//   5. forward {signature, blockHeight, parentSlot, blockTime, txIndex, outerIx, innerIx,
//      eventBase64 = disc(8) ‖ borsh}. `name` is a routing hint; the server re-decodes with the
//      IDL compiled into it and ignores `name`.
//
// No BigInt / atob / TextDecoder / Buffer / require: QuickNode's JS engine is undocumented.
// Adapted from youre-on-spikes/06-quicknode-solana/filter/stream-filter.js (base58 / base64
// helpers, block walking) with Verdict's infra/quicknode layout (CONFIG + stream.json).
//
// The CONFIG block is generated: `npx tsx infra/quicknode/build-filter.ts` (from the escrow IDL
// and ESCROW_ID). apps/server/test/chain-unit.test.ts fails if it drifts.
/*__CONFIG_START__*/
var CONFIG = {
  programId: 'FyJQHCE1TBuaCtaueeoSzLDzV5Gns6iUSA7Yd2m8UNvm',
  eventAuthority: '9j8rLku2jyJ11H4cgPXoEK2ea3cQdKp6XW5Kx1pWs8ME',
  eventIxTag: [228, 69, 165, 46, 81, 203, 154, 29],
  events: {
    '820c89bfbdd91abd': 'AppealResolved',
    a6f9b64d551fe164: 'BetAccepted',
    '89d7039bc4cb4fd7': 'BetAppealed',
    '20b380b87dc16a68': 'BetCancelled',
    '7a149dfedd002781': 'BetClosed',
    '8d5c42c6b1d3bb91': 'BetConceded',
    '20996947bc486b72': 'BetCreated',
    '3af4902f755cc791': 'BetFinalized',
    '20eaad666a0402cb': 'BetRefunded',
    '8559597d04db5289': 'BetResolved',
    b531c89c13a7b25b: 'ConfigInitialized',
    '28f1e67a0b13c6c2': 'ConfigUpdated',
  },
};
/*__CONFIG_END__*/

var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b58decode(s) {
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    var v = B58.indexOf(s.charAt(i));
    if (v < 0) return null;
    var carry = v;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (var k = 0; k < s.length && s.charAt(k) === '1'; k++) bytes.push(0);
  return bytes.reverse();
}

function b64decode(s) {
  var out = [];
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '=') break;
    var v = B64.indexOf(c);
    if (v < 0) return null;
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function b64encode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i];
    var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var n = (a << 16) | (b << 8) | c;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=';
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '=';
  }
  return out;
}

function hexOf(bytes, off, n) {
  var s = '';
  for (var i = off; i < off + n; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function keyStr(k) {
  return typeof k === 'string' ? k : k && k.pubkey;
}

// json: static keys, then loadedAddresses.writable, then .readonly (the runtime's index order).
// jsonParsed: accountKeys are objects that already include the lookup-table keys.
function accountKeysOf(tx) {
  var msg = tx.transaction && tx.transaction.message;
  var keys = (msg && msg.accountKeys) || [];
  var all = [];
  var parsed = false;
  for (var i = 0; i < keys.length; i++) {
    if (typeof keys[i] !== 'string') parsed = true;
    all.push(keyStr(keys[i]));
  }
  var la = tx.meta && tx.meta.loadedAddresses;
  if (la && !parsed) all = all.concat(la.writable || [], la.readonly || []);
  return all;
}

function accountAt(ix, keys, n) {
  var a = ix.accounts && ix.accounts[n];
  if (typeof a === 'number') return keys[a];
  return keyStr(a);
}

function ixData(ix) {
  var d = ix.data;
  if (typeof d === 'string') return b58decode(d);
  if (d && d.length === 2 && typeof d[0] === 'string') {
    return d[1] === 'base64' ? b64decode(d[0]) : b58decode(d[0]);
  }
  return null;
}

function eventsOf(tx, keys) {
  var out = [];
  var inner = (tx.meta && tx.meta.innerInstructions) || [];
  for (var g = 0; g < inner.length; g++) {
    var ixs = inner[g].instructions || [];
    for (var j = 0; j < ixs.length; j++) {
      var ix = ixs[j];
      var pid = ix.programId || (ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : null);
      if (pid !== CONFIG.programId) continue;
      if (accountAt(ix, keys, 0) !== CONFIG.eventAuthority) continue;
      var bytes = ixData(ix);
      if (!bytes || bytes.length < 16 || !startsWith(bytes, CONFIG.eventIxTag)) continue;
      out.push({
        outerIx: inner[g].index,
        innerIx: j,
        name: CONFIG.events[hexOf(bytes, 8, 8)] || null,
        eventBase64: b64encode(bytes.slice(8)),
      });
    }
  }
  return out;
}

function main(stream) {
  var data = stream && stream.data ? stream.data : stream;
  var meta = (stream && stream.metadata) || {};
  if (!data || !data.length) return null;
  var txs = [];
  for (var b = 0; b < data.length; b++) {
    var blk = data[b];
    if (!blk || !blk.transactions) continue;
    for (var t = 0; t < blk.transactions.length; t++) {
      var tx = blk.transactions[t];
      if (!tx || !tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) continue;
      var keys = accountKeysOf(tx);
      if (keys.indexOf(CONFIG.programId) < 0) continue; // cheap pre-filter
      var events = eventsOf(tx, keys);
      if (!events.length) continue;
      txs.push({
        signature: tx.transaction.signatures[0],
        blockHeight: blk.blockHeight === undefined ? null : blk.blockHeight,
        parentSlot: blk.parentSlot === undefined ? null : blk.parentSlot,
        blockTime: blk.blockTime === undefined ? null : blk.blockTime,
        txIndex: t,
        events: events,
      });
    }
  }
  if (!txs.length) return null;
  return {
    v: 1,
    programId: CONFIG.programId,
    network: meta.network === undefined ? null : meta.network,
    dataset: meta.dataset === undefined ? null : meta.dataset,
    batchStart: meta.batch_start_range === undefined ? null : meta.batch_start_range,
    batchEnd: meta.batch_end_range === undefined ? null : meta.batch_end_range,
    txs: txs,
  };
}

// Node-only test hook; QuickNode calls main() directly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { main: main, CONFIG: CONFIG, b58decode: b58decode, b64encode: b64encode };
}
