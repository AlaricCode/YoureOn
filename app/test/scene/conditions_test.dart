import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/bet.dart';
import 'package:verdict/api/models/program.dart';
import 'package:verdict/api/models/scene.dart';
import 'package:verdict/scene/conditions.dart';

import '../support/fixtures.dart';

Program _program() {
  final p = programJson();
  p['legs'] = [
    {
      'id': 1,
      'actor_bound': true,
      'attempt_window_frames': 50,
      'valid_attempt': {
        'op': 'and',
        'args': [
          {'op': 'behind', 'a': {'e': 'shooter'}, 'b': {'e': 'line'}},
          {'op': 'released_by', 'a': {'e': 'ball'}, 'b': {'e': 'shooter'}},
        ],
      },
      'success': {
        'op': 'then_within',
        'frames': 30,
        'first': {'op': 'not', 'arg': {'op': 'touches', 'a': {'e': 'ball'}, 'b': {'e': 'bin'}}},
        'then': {'op': 'disappears_into', 'a': {'e': 'ball'}, 'b': {'e': 'bin', 'sub': 'opening'}},
      },
      'rule': {'kind': 'count', 'cmp': '>=', 'k': 1, 'attempts': 3},
    },
  ];
  return Program.fromJson(p);
}

ConditionState _s(String field, String path, bool state, {bool placed = true}) =>
    ConditionState(leg: 1, field: field, path: path, label: 'x', state: state, placed: placed);

void main() {
  final p = _program();

  test('exprAt walks child indices in AST field order', () {
    expect(exprAt(p, 1, 'valid_attempt', '')!['op'], 'and');
    expect(exprAt(p, 1, 'valid_attempt', '0')!['op'], 'behind');
    expect(exprAt(p, 1, 'valid_attempt', '1')!['op'], 'released_by');
    expect(exprAt(p, 1, 'success', '0')!['op'], 'not');
    expect(exprAt(p, 1, 'success', '0.0')!['op'], 'touches');
    expect(exprAt(p, 1, 'success', '1')!['op'], 'disappears_into');
    expect(exprAt(p, 1, 'success', '2'), isNull);
    expect(exprAt(p, 2, 'success', ''), isNull, reason: 'leg is matched by id');
  });

  test('event rows are the §3.5 pulse primitives', () {
    expect(isEventRow(p, 1, 'valid_attempt', '0'), isFalse);
    expect(isEventRow(p, 1, 'valid_attempt', '1'), isTrue);
    expect(isEventRow(p, 1, 'success', '0.0'), isTrue);
    expect(isEventRow(p, 1, 'success', '1'), isTrue);
  });

  test('entities and openings are collected from the program', () {
    expect(exprEntities(exprAt(p, 1, 'valid_attempt', '')!), {'shooter', 'line', 'ball'});
    expect(openingEntities(p), {'bin'});
    // (x0 + w/10, max(0, y0 - h/10), x1 - w/10, y0 + h/5)
    expect(openingRect([1000, 500, 3000, 5500]), [1200, 0, 2800, 1500]);
    expect(openingRect([1000, 2000, 3005, 4009]), [1200, 1800, 2805, 2401]);
  });

  test('event rows latch for PULSE_LATCH_FRAMES; level rows do not', () {
    var now = 1000;
    final board = ConditionBoard(nowMs: () => now);
    final refs = [
      const ConditionRef(leg: 1, field: 'valid_attempt', path: '0', label: 'Behind line'),
      const ConditionRef(leg: 1, field: 'success', path: '1', label: 'Into Can'),
    ];
    board.update([_s('valid_attempt', '0', true), _s('success', '1', true)]);
    var rows = board.rows(p, refs);
    expect(rows.map((r) => r.on), [true, true]);

    now += 500;
    board.update([_s('valid_attempt', '0', false), _s('success', '1', false)]);
    rows = board.rows(p, refs);
    expect(rows.map((r) => r.on), [false, true], reason: 'pulse latched for 1 s');

    now += kLatchMs;
    rows = board.rows(p, refs);
    expect(rows.map((r) => r.on), [false, false]);
    expect(kLatchMs, 1000);
  });

  test('rows keep descriptor order, add live-only rows and grey unplaced regions', () {
    final board = ConditionBoard(nowMs: () => 0);
    final refs = [const ConditionRef(leg: 1, field: 'valid_attempt', path: '0', label: 'Behind line')];
    board.update([_s('success', '1', false), _s('valid_attempt', '0', true, placed: true)]);
    var rows = board.rows(p, refs);
    expect(rows.map((r) => r.key), ['1/valid_attempt/0', '1/success/1']);
    expect(rows.first.placed, isTrue);

    rows = board.rows(p, refs, unplaced: {'line'});
    expect(rows.first.placed, isFalse);
    expect(rows.first.on, isFalse, reason: 'an unplaced row never shows on');
    expect(rows.last.placed, isTrue);

    board.update([_s('valid_attempt', '0', false, placed: false)]);
    expect(board.rows(p, refs).first.placed, isFalse);
  });

  test('practice rows', () {
    final rows = practiceRows(const [
      PracticeCondition(leg: 1, field: 'success', path: '1', label: 'Into Can', fired: true, frame: 12),
      PracticeCondition(leg: 1, field: 'valid_attempt', path: '0', label: 'Behind line', fired: false, frame: null),
    ]);
    expect(rows.map((r) => r.on), [true, false]);
    expect(rows.first.label, 'Into Can');
  });
}
