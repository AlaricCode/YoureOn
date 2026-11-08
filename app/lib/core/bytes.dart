import 'dart:convert';
import 'dart:typed_data';

/// Little-endian byte builder (CONTRACTS.md §0.1).
///
/// All integer writers check their range, so a bad value fails loudly instead
/// of silently wrapping into a different hash.
class ByteWriter {
  final BytesBuilder _b = BytesBuilder(copy: false);

  int get length => _b.length;

  void bytes(List<int> data) => _b.add(Uint8List.fromList(data));

  /// Writes exactly [n] bytes; throws if [data] has a different length.
  void fixed(List<int> data, int n) {
    if (data.length != n) {
      throw ArgumentError('expected $n bytes, got ${data.length}');
    }
    bytes(data);
  }

  void ascii(String s) {
    final units = s.codeUnits;
    for (final u in units) {
      if (u > 0x7f) throw ArgumentError('non-ASCII tag: $s');
    }
    bytes(units);
  }

  void u8(int v) {
    _check(v, 0, 0xff, 'u8');
    _b.addByte(v);
  }

  void u16(int v) {
    _check(v, 0, 0xffff, 'u16');
    _b.add([v & 0xff, (v >> 8) & 0xff]);
  }

  void u32(int v) {
    _check(v, 0, 0xffffffff, 'u32');
    final d = ByteData(4)..setUint32(0, v, Endian.little);
    _b.add(d.buffer.asUint8List());
  }

  /// u64 from a non-negative Dart int (always < 2^63 on the VM).
  void u64(int v) {
    if (v < 0) throw ArgumentError('u64 out of range: $v');
    u64Big(BigInt.from(v));
  }

  /// u64 from a BigInt (slots arrive as decimal strings and may exceed 2^53).
  void u64Big(BigInt v) {
    if (v.isNegative || v.bitLength > 64) {
      throw ArgumentError('u64 out of range: $v');
    }
    final out = Uint8List(8);
    var x = v;
    final mask = BigInt.from(0xff);
    for (var i = 0; i < 8; i++) {
      out[i] = (x & mask).toInt();
      x = x >> 8;
    }
    _b.add(out);
  }

  void i64(int v) {
    // Two's complement, little-endian. Done byte-wise so it also works where
    // ByteData.setInt64 is unavailable (web).
    var x = BigInt.from(v);
    if (x.isNegative) x += BigInt.one << 64;
    u64Big(x);
  }

  Uint8List toBytes() => _b.toBytes();

  static void _check(int v, int lo, int hi, String t) {
    if (v < lo || v > hi) throw ArgumentError('$t out of range: $v');
  }
}

/// Little-endian reader used by tests and by the beacon/WAV helpers.
class ByteReader {
  ByteReader(this._data);
  final Uint8List _data;
  int _o = 0;

  int get offset => _o;
  int get remaining => _data.length - _o;

  Uint8List take(int n) {
    if (n > remaining) throw const FormatException('truncated');
    final r = Uint8List.sublistView(_data, _o, _o + n);
    _o += n;
    return r;
  }

  int u8() => take(1)[0];
  int u16() => ByteData.sublistView(take(2)).getUint16(0, Endian.little);
  int u32() => ByteData.sublistView(take(4)).getUint32(0, Endian.little);
}

const _hexDigits = '0123456789abcdef';

/// Lowercase hex, no `0x` (§0.2).
String toHex(List<int> bytes) {
  final sb = StringBuffer();
  for (final b in bytes) {
    sb
      ..write(_hexDigits[(b >> 4) & 0xf])
      ..write(_hexDigits[b & 0xf]);
  }
  return sb.toString();
}

Uint8List fromHex(String hex) {
  var h = hex;
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.substring(2);
  if (h.length.isOdd) throw FormatException('odd-length hex', hex);
  final out = Uint8List(h.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    final v = int.tryParse(h.substring(2 * i, 2 * i + 2), radix: 16);
    if (v == null) throw FormatException('bad hex', hex);
    out[i] = v;
  }
  return out;
}

/// Standard base64 with padding (§0.2).
String toB64(List<int> bytes) => base64.encode(bytes);
Uint8List fromB64(String s) => base64.decode(s);

bool bytesEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

Uint8List concatBytes(List<List<int>> parts) {
  final b = BytesBuilder(copy: false);
  for (final p in parts) {
    b.add(p);
  }
  return b.toBytes();
}
