import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/core/format.dart';

void main() {
  test('money (§12.9)', () {
    expect(formatUsd(0), r'$0.00');
    expect(formatUsd(5000000), r'$5.00');
    expect(formatUsd(10000), r'$0.01');
    expect(formatUsd(9999), r'$0.00'); // floor to cents
    expect(formatUsd(1234500000), r'$1,234.50');
    expect(formatUsd(1000000000000), r'$1,000,000.00');
    expect(formatSignedUsd(5000000), r'+$5.00');
    expect(formatSignedUsd(-5000000), '−\$5.00');
    expect(formatSignedUsd(0), r'$0.00');
    expect(() => formatUsd(-1), throwsArgumentError);
  });

  test('parse dollars', () {
    expect(parseUsd('5'), 5000000);
    expect(parseUsd(r'$1,234.5'), 1234500000);
    expect(parseUsd('0.01'), 10000);
    expect(parseUsd('1.234'), isNull);
    expect(parseUsd('-1'), isNull);
    expect(parseUsd('abc'), isNull);
  });

  test('durations (§2.8)', () {
    expect(formatFrames(15), '1.5s');
    expect(formatFrames(50), '5s');
    expect(formatFrames(600), '1m');
    expect(formatFrames(1250), '2m 5s');
    expect(formatFrames(605), '60.5s');
    expect(formatSeconds(120), '2m');
    expect(formatClock(65000), '1:05');
    expect(formatClock(-5), '0:00');
  });
}
