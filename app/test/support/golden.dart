// Golden values computed independently with Node's `crypto` (sha256 and
// ed25519 from OpenSSL), straight from CONTRACTS.md §7.2 / §7.3 / §7.4 /
// §7.5 / §12.3. Inputs:
//   seed        = bytes 1..32
//   bet         = sha256("bet")            (as the Bet PDA)
//   witness key = ed25519 public key of seed, kind = audio (1)
//   beacon      = slot 12345678901, hash sha256("beacon")
//   chunks      = bodies "chunk-0/1/2", start 0/5000/10000, dur 5000/5000/1234

import 'dart:typed_data';

final Uint8List kSeed = Uint8List.fromList(List<int>.generate(32, (i) => i + 1));

const String kPubHex = '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';
const String kPub58 = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';
const String kLoginNonce = 'nonce-123';
const String kLoginSigHex =
    '04a6090c9b92f8ea2b2e27b8f0ef3fd7cfcf8b2b16e5801a17e78fde143e3e7aa75c20f99c94f9aad378e59b4caeb9e419dbaecd63165ef6666ed7d8dcc64807';

const String kBet58 = 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9';
const String kBeaconHashHex = '8a62e967fcd6dfa5d75308c37808b4668a7faf1cdb06e09ac0a7161827603887';
final BigInt kBeaconSlot = BigInt.parse('12345678901');

const String kGenesisHex = '5ef02fa7921e95e39475646be918b0b5c7543a3bd16a9a09b5b50e91a0c4a3a2';
const List<String> kChunkHex = [
  '6fe4c9ec7188dc555a7d89ec79b5832d69340a3c74859525f7b6b0b33bc8ea35',
  '57e7d8826bb91ad6f449eba852e854ba2cc4f90304fddb5d7f41004b7a577631',
  'e23e3124ff128abf485e6e78e21e31d7b00300b8278ca2bede29acaa704acc99',
];
const List<int> kChunkStarts = [0, 5000, 10000];
const List<int> kChunkDurations = [5000, 5000, 1234];
const String kSig0Hex =
    '8643bc6cd3d145f7d0ea68591cbf634470e561d02195633ae53e20a80636b8f9fd9d458dc682b985dc3d60a70dc06fe33bc5eff395e9301edf37369d0c40c806';

/// sha256 of the accept-sig message for program_hash = sha256("program"),
/// wav = "wav-bytes".
const String kAcceptMsgShaHex = 'c7e37af5d89fe48585977405cb28291b3fd315213db96cd1e32b8e4406da86df';

/// Merkle roots over leaves sha256([i]) for i in 0..4 and 0..2.
const String kMerkle5Hex = '550347fe72bcb7c23a0576eb793f410a6192c5d678b483eb1adfd880720b55ea';
const String kMerkle3Hex = 'd78663a8f1a2d99ee97fe38a605be2f54e2872c3a63a13077d617e4a940725bd';

/// Evidence leaf of the witness above with no chunks (index 0xFFFFFFFF, G_w).
const String kEmptyLeafHex = 'b6dd59a9dcc85856a12d4711189c158af61cd6918b54fc9ead34e2f3d9843d16';

const String kBeaconPayloadHex = '351cdcdf020000008a62e967fcd6dfa5a2d0';
const List<int> kBeaconSymbols = [
  0, 15, 0, 15, 0, 15, 3, 5, 1, 12, 13, 12, 13, 15, 0, 2, 0, 0, 0, 0, 0, 0, //
  8, 10, 6, 2, 14, 9, 6, 7, 15, 12, 13, 6, 13, 15, 10, 5, 10, 2, 13, 0,
];
