import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/calibration.dart';
import 'package:verdict/api/models/program.dart';
import 'package:verdict/evidence/chunk_uploader.dart';
import 'package:verdict/scene/placement.dart';

import '../support/fixtures.dart';

const _line = ProgramEntity(name: 'line', kind: 'region', shape: 'line');
const _zone = ProgramEntity(name: 'mat', kind: 'region', shape: 'zone');

void main() {
  test('a line is two taps plus a side tap; behind_sign = side(L, tap)', () {
    final pl = Placement()..beginRegion(_line);
    expect(pl.step, PlacementStep.lineStart);
    expect(pl.tap([3000, 6000]), isNull);
    expect(pl.step, PlacementStep.lineEnd);
    expect(pl.tap([3000, 6000]), isNull, reason: 'degenerate line rejected');
    expect(pl.step, PlacementStep.lineEnd);
    expect(pl.tap([3000, 10000]), isNull);
    expect(pl.step, PlacementStep.lineSide);
    expect(pl.tap([3000, 8000]), isNull, reason: 'a tap on the line is ignored');
    // (b − a) = (0, 4000); tap − a = (−1000, 1000): cross = 0·1000 − 4000·(−1000) > 0.
    final r = pl.tap([2000, 7000])!;
    expect(r.shape, 'line');
    expect(r.points, [
      [3000, 6000],
      [3000, 10000],
    ]);
    expect(r.behindSign, 1);
    expect(r.valid, isTrue);
    expect(pl.regions['line'], same(r));
    expect(pl.active, isFalse);

    pl.beginRegion(_line);
    pl
      ..tap([3000, 6000])
      ..tap([3000, 10000]);
    expect(pl.tap([4000, 7000])!.behindSign, -1);
  });

  test('a zone takes 3..8 corners', () {
    final pl = Placement()..beginRegion(_zone);
    pl
      ..tap([0, 0])
      ..tap([100, 0]);
    expect(pl.canFinishZone, isFalse);
    expect(pl.finishZone(), isNull);
    pl.tap([100, 100]);
    expect(pl.canFinishZone, isTrue);
    final r = pl.finishZone()!;
    expect(r.points.length, 3);
    expect(r.valid, isTrue);

    pl.beginRegion(_zone);
    Region? auto;
    for (var i = 0; i < 8; i++) {
      auto = pl.tap([i * 100, i * 50]);
    }
    expect(auto, isNotNull, reason: 'auto-finished at 8 vertices');
    expect(auto!.points.length, 8);
  });

  test('label correction target and box helpers', () {
    final pl = Placement()..beginLabel('bin');
    expect(pl.step.prompt, 'Tap object');
    expect(pl.tap([1, 1]), isNull);
    expect(pl.takeLabelTarget(), 'bin');
    expect(pl.active, isFalse);
    expect(boxAround([500, 9800]), [0, 8800, 1500, 10000]);
    expect(
      smallestContaining([
        [0, 0, 10000, 10000],
        [4000, 4000, 6000, 6000],
        [7000, 7000, 8000, 8000],
      ], [5000, 5000]),
      [4000, 4000, 6000, 6000],
    );
    expect(smallestContaining([[0, 0, 10, 10]], [50, 50]), isNull);
  });

  test('every placement prompt is a 1–3 word label', () {
    for (final s in PlacementStep.values) {
      final p = s.prompt;
      if (p != null) expect(p.split(' ').length, lessThanOrEqualTo(3));
    }
  });

  test('calibration draft: entity order, corrections win over detections', () {
    final program = Program.fromJson(programJson());
    final d = CalibrationDraft(camera: const CameraMeta(widthPx: 720, heightPx: 1280, orientation: 'portrait'))
      ..refFrameSha256 = 'ee' * 32
      ..pose = const CameraPose(pitchCdeg: -120, rollCdeg: 30);
    expect(d.complete(program, const {}), isFalse);
    expect(d.missingRegions(program, const {}).map((e) => e.name), ['line']);

    d.detected('bin', 'Trash Can', [6000, 5000, 8000, 9000]);
    d.detected('ball', 'Paper Ball', [100, 100, 200, 200]);
    d.correct('ball', 'Paper Ball', [300, 300, 400, 400]);
    d.detected('ball', 'Paper Ball', [100, 100, 200, 200]); // ignored
    d.setCrop('ball', 'ff' * 32);

    final regions = {
      'line': const Region.line(entity: 'line', points: [[3000, 6000], [3000, 10000]], behindSign: 1),
    };
    expect(d.complete(program, regions), isTrue);
    final c = d.build(program, regions).toJson();
    expect(c['version'], 1);
    final scene = c['scene'] as Map;
    expect(scene['camera'], {
      'width_px': 720,
      'height_px': 1280,
      'orientation': 'portrait',
      'ref_frame_sha256': 'ee' * 32,
      'pose': {'pitch_cdeg': -120, 'roll_cdeg': 30},
    });
    expect((scene['entity_refs'] as List).map((e) => (e as Map)['entity']), ['ball', 'bin'], reason: 'program order');
    expect((scene['entity_refs'] as List).first, {
      'entity': 'ball',
      'label': 'Paper Ball',
      'bbox': [300, 300, 400, 400],
      'crop_sha256': 'ff' * 32,
    });
    expect((c['regions'] as List).single, {
      'entity': 'line',
      'shape': 'line',
      'points': [[3000, 6000], [3000, 10000]],
      'behind_sign': 1,
    });
    expect(sameCalibration(d.build(program, regions), d.build(program, regions)), isTrue);
  });
}
