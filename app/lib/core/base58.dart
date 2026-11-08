import 'dart:typed_data';

/// Bitcoin/Solana base58 alphabet. Public keys travel as base58 (§0.2).
const String _alphabet =
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

final Map<int, int> _index = {
  for (var i = 0; i < _alphabet.length; i++) _alphabet.codeUnitAt(i): i,
};

String base58Encode(List<int> input) {
  if (input.isEmpty) return '';
  var zeros = 0;
  while (zeros < input.length && input[zeros] == 0) {
    zeros++;
  }
  // Repeated division of a base-256 big number by 58, digits little-endian.
  final digits = <int>[];
  for (var i = zeros; i < input.length; i++) {
    var carry = input[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry ~/= 58;
    }
    while (carry > 0) {
      digits.add(carry % 58);
      carry ~/= 58;
    }
  }
  final sb = StringBuffer();
  for (var i = 0; i < zeros; i++) {
    sb.write('1');
  }
  for (var i = digits.length - 1; i >= 0; i--) {
    sb.write(_alphabet[digits[i]]);
  }
  return sb.toString();
}

Uint8List base58Decode(String input) {
  if (input.isEmpty) return Uint8List(0);
  var zeros = 0;
  while (zeros < input.length && input.codeUnitAt(zeros) == 0x31) {
    zeros++;
  }
  final bytes = <int>[]; // little-endian base-256
  for (var i = zeros; i < input.length; i++) {
    final v = _index[input.codeUnitAt(i)];
    if (v == null) throw FormatException('invalid base58 character', input, i);
    var carry = v;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.add(carry & 0xff);
      carry >>= 8;
    }
  }
  final out = Uint8List(zeros + bytes.length);
  for (var i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i];
  }
  return out;
}

/// Decodes a base58 public key and checks it is 32 bytes.
Uint8List pubkeyBytes(String base58) {
  final b = base58Decode(base58);
  if (b.length != 32) {
    throw FormatException('public key must be 32 bytes, got ${b.length}');
  }
  return b;
}
