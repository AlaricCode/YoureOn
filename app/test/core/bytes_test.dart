import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/core/base58.dart';
import 'package:verdict/core/bytes.dart';

import '../support/golden.dart';

void main() {
  group('ByteWriter', () {
    test('little-endian integers', () {
      final w = ByteWriter()
        ..u8(0xab)
        ..u16(0x0102)
        ..u32(0x01020304)
        ..u64(0x0102030405060708);
      expect(toHex(w.toBytes()), 'ab' '0201' '04030201' '0807060504030201');
    });

    test('i64 two\'s complement', () {
      expect(toHex((ByteWriter()..i64(-1)).toBytes()), 'ffffffffffffffff');
      expect(toHex((ByteWriter()..i64(-2)).toBytes()), 'feffffffffffffff');
      expect(toHex((ByteWriter()..i64(5000)).toBytes()), '8813000000000000');
    });

    test('u64 from BigInt above 2^63', () {
      final v = (BigInt.one << 64) - BigInt.one;
      expect(toHex((ByteWriter()..u64Big(v)).toBytes()), 'ffffffffffffffff');
      expect(() => ByteWriter().u64Big(BigInt.one << 64), throwsArgumentError);
    });

    test('range checks', () {
      expect(() => ByteWriter().u8(256), throwsArgumentError);
      expect(() => ByteWriter().u32(-1), throwsArgumentError);
      expect(() => ByteWriter().u32(0x100000000), throwsArgumentError);
      expect(() => ByteWriter().fixed([1, 2], 3), throwsArgumentError);
      expect(() => ByteWriter().ascii('é'), throwsArgumentError);
    });
  });

  group('hex / base64', () {
    test('round trip', () {
      final b = Uint8List.fromList([0, 1, 0x7f, 0x80, 0xff]);
      expect(toHex(b), '00017f80ff');
      expect(fromHex('00017f80ff'), b);
      expect(fromHex('0x00017F80FF'), b);
      expect(fromB64(toB64(b)), b);
    });

    test('bad hex', () {
      expect(() => fromHex('abc'), throwsFormatException);
      expect(() => fromHex('zz'), throwsFormatException);
    });
  });

  group('base58', () {
    test('golden public key', () {
      expect(base58Encode(fromHex(kPubHex)), kPub58);
      expect(toHex(base58Decode(kPub58)), kPubHex);
    });

    test('leading zeros', () {
      final b = Uint8List.fromList([0, 0, 1, 2, 3, 255]);
      expect(base58Encode(b), '112VfYr');
      expect(base58Decode('112VfYr'), b);
      expect(base58Encode(Uint8List(3)), '111');
      expect(base58Decode('111'), Uint8List(3));
    });

    test('rejects invalid characters and wrong key length', () {
      expect(() => base58Decode('0OIl'), throwsFormatException);
      expect(() => pubkeyBytes('112VfYr'), throwsFormatException);
    });
  });
}
