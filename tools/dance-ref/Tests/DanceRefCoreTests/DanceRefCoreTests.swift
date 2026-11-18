import XCTest

@testable import DanceRefCore

final class JointsTests: XCTestCase {
  func testOrderMatchesContract() {
    XCTAssertEqual(
      Joints.names,
      [
        "nose", "leftEye", "rightEye", "leftEar", "rightEar", "neck", "leftShoulder",
        "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "root", "leftHip",
        "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
      ])
    XCTAssertEqual(Joints.names.count, Joints.count)
    XCTAssertEqual(Joints.count * 3, Joints.valuesPerPerson)
  }

  func testMirrorIndexSwapsEveryLeftRightPairAndIsAnInvolution() {
    XCTAssertEqual(Joints.mirrorIndex.count, Joints.count)
    for (i, j) in Joints.mirrorIndex.enumerated() {
      XCTAssertEqual(Joints.mirrorIndex[j], i, "mirror twice is identity at \(i)")
      let a = Joints.names[i]
      let b = Joints.names[j]
      if a.hasPrefix("left") {
        XCTAssertEqual(b, "right" + a.dropFirst(4))
      } else if a.hasPrefix("right") {
        XCTAssertEqual(b, "left" + a.dropFirst(5))
      } else {
        XCTAssertEqual(i, j, "\(a) has no partner")
      }
    }
  }

  func testFlipsYToTopLeftOrigin() {
    var pts = [VisionPoint?](repeating: nil, count: Joints.count)
    pts[0] = VisionPoint(x: 0.25, y: 0.9, c: 0.8)  // nose near the top (Vision: bottom-left origin)
    let k = contractKeypoints(pts, mirrored: false)
    XCTAssertEqual(k.count, 57)
    XCTAssertEqual(k[0], 0.25, accuracy: 1e-12)
    XCTAssertEqual(k[1], 0.1, accuracy: 1e-12)
    XCTAssertEqual(k[2], 0.8, accuracy: 1e-12)
    XCTAssertEqual(Array(k[3...]), [Double](repeating: 0, count: 54), "missing joints are [0,0,0]")
  }

  func testMirroredFlipsXAndSwapsLabels() {
    var pts = [VisionPoint?](repeating: nil, count: Joints.count)
    pts[10] = VisionPoint(x: 0.2, y: 0.7, c: 0.9)  // leftWrist
    pts[0] = VisionPoint(x: 0.5, y: 0.5, c: 1)  // nose stays nose
    let k = contractKeypoints(pts, mirrored: true)
    // leftWrist at x 0.2 in a mirrored image is the dancer's right wrist at x 0.8.
    XCTAssertEqual(k[33], 0.8, accuracy: 1e-12)  // rightWrist x
    XCTAssertEqual(k[34], 0.3, accuracy: 1e-12)
    XCTAssertEqual(k[35], 0.9, accuracy: 1e-12)
    XCTAssertEqual(k[30], 0)  // leftWrist slot is empty
    XCTAssertEqual(k[32], 0)
    XCTAssertEqual(k[0], 0.5, accuracy: 1e-12)
  }

  func testZeroConfidenceAndNonFiniteValuesAreMissingOrClamped() {
    var pts = [VisionPoint?](repeating: nil, count: Joints.count)
    pts[1] = VisionPoint(x: 0.4, y: 0.4, c: 0)
    pts[2] = VisionPoint(x: .nan, y: 1.5, c: 2)
    let k = contractKeypoints(pts, mirrored: false)
    XCTAssertEqual(Array(k[3..<6]), [0, 0, 0])
    XCTAssertEqual(Array(k[6..<9]), [0, 0, 1])
    XCTAssertTrue(k.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 })
  }

  func testPicksTheLargestConfidentPerson() {
    let size = ImageSize(w: 720, h: 1280)
    func person(_ x0: Double, _ x1: Double, _ y0: Double, _ y1: Double, c: Double) -> [Double] {
      var k = [Double](repeating: 0, count: 57)
      for j in 0..<19 {
        k[3 * j] = j % 2 == 0 ? x0 : x1
        k[3 * j + 1] = j < 10 ? y0 : y1
        k[3 * j + 2] = c
      }
      return k
    }
    let small = person(0.1, 0.2, 0.4, 0.6, c: 0.9)
    let big = person(0.4, 0.7, 0.1, 0.9, c: 0.8)
    XCTAssertEqual(pickPerson([small, big], size: size), 1)
    XCTAssertEqual(pickPerson([big, small], size: size), 0)
    XCTAssertNil(pickPerson([], size: size))
    XCTAssertNil(pickPerson([[Double](repeating: 0, count: 57)], size: size))
  }
}

final class OrientationTests: XCTestCase {
  func testPreferredTransformMapping() {
    XCTAssertEqual(orientation(a: 1, b: 0, c: 0, d: 1), .up)
    XCTAssertEqual(orientation(a: 0, b: 1, c: -1, d: 0), .right)  // iPhone portrait
    XCTAssertEqual(orientation(a: 0, b: -1, c: 1, d: 0), .left)
    XCTAssertEqual(orientation(a: -1, b: 0, c: 0, d: -1), .down)
    XCTAssertEqual(orientation(a: -1, b: 0, c: 0, d: 1), .upMirrored)
    XCTAssertEqual(orientation(a: 1, b: 0, c: 0, d: -1), .downMirrored)
    XCTAssertEqual(orientation(a: 0, b: 1, c: 1, d: 0), .leftMirrored)
    XCTAssertEqual(orientation(a: 0, b: -1, c: -1, d: 0), .rightMirrored)
    // Float noise from the container still maps.
    XCTAssertEqual(orientation(a: 1e-9, b: 0.9999999, c: -1.0000001, d: -1e-9), .right)
    XCTAssertEqual(orientation(a: 0.7, b: 0.7, c: -0.7, d: 0.7), .up)
  }

  func testRawValuesAreExif() {
    XCTAssertEqual(ExifOrientation.up.rawValue, 1)
    XCTAssertEqual(ExifOrientation.right.rawValue, 6)
    XCTAssertEqual(ExifOrientation.left.rawValue, 8)
  }

  func testUprightSizeSwapsOnQuarterTurns() {
    XCTAssertEqual(
      uprightSize(bufferWidth: 1920, bufferHeight: 1080, orientation: .right),
      ImageSize(w: 1080, h: 1920))
    XCTAssertEqual(
      uprightSize(bufferWidth: 1920, bufferHeight: 1080, orientation: .down),
      ImageSize(w: 1920, h: 1080))
  }
}

final class SamplingTests: XCTestCase {
  func times(sourceFps: Double, fps: Int, durationMs: Int, startAt: Double = 0) -> [Double] {
    var s = FrameSampler(fps: fps, durationMs: durationMs)
    var out: [Double] = []
    var i = 0
    while true {
      let t = startAt + Double(i) * 1000 / sourceFps
      if t >= Double(durationMs) + 500 { break }
      if s.accept(tMs: t) { out.append(t) }
      i += 1
    }
    return out
  }

  func testHalvesA30FpsSource() {
    let got = times(sourceFps: 30, fps: 15, durationMs: 15000)
    XCTAssertEqual(got.count, 225)
    XCTAssertEqual(got.first ?? -1, 0, accuracy: 1e-9)
    XCTAssertEqual(got[1], 66.666, accuracy: 0.01)
  }

  func testKeepsEveryFrameAtTheSameRateIncluding2997() {
    XCTAssertEqual(times(sourceFps: 30, fps: 30, durationMs: 15000).count, 450)
    XCTAssertEqual(times(sourceFps: 29.97, fps: 30, durationMs: 15000).count, 450)
  }

  func testRejectsOutsideTheRoutine() {
    var s = FrameSampler(fps: 15, durationMs: 1000)
    XCTAssertFalse(s.accept(tMs: -40))
    XCTAssertTrue(s.accept(tMs: 3))
    XCTAssertFalse(s.accept(tMs: 1000))
    XCTAssertFalse(s.accept(tMs: .nan))
    XCTAssertEqual(frameTimeMs(-0.4), 0)
    XCTAssertEqual(frameTimeMs(66.6), 67)
  }
}

final class KeyMoveTests: XCTestCase {
  func testEveryFourBeatsAt120Bpm() {
    // 500 ms per beat, every 4 beats = 2000 ms, first beat at 500 ms.
    let t = everyKBeats(bpm: 120, firstBeatMs: 500, every: 4, durationMs: 15000)
    XCTAssertEqual(t, [500, 2500, 4500, 6500, 8500, 10500, 12500, 14500])
  }

  func testEveryTwoBeatsKeepsTheGridAndTheWindows() {
    // 100 bpm = 600 ms per beat; every 2 = 1200 ms from 0. 0 is skipped (lead-in), 15600 is past
    // the tail, so 1200..14400.
    let t = everyKBeats(bpm: 100, firstBeatMs: 0, every: 2, durationMs: 15000)
    XCTAssertEqual(t.first, 1200)
    XCTAssertEqual(t.last, 14400)
    XCTAssertEqual(t.count, 12)
    XCTAssertTrue(t.allSatisfy { $0 >= KEY_LEAD_MS && $0 <= 15000 - KEY_TAIL_MS })
  }

  func testIdsAndNames() {
    let m = makeKeyMoves(times: [3000, 1000, 2000], names: ["Arms up", " ", "Spin"])
    XCTAssertEqual(m.map(\.id), ["km01", "km02", "km03"])
    XCTAssertEqual(m.map(\.t), [1000, 2000, 3000])
    XCTAssertEqual(m.map(\.name), ["Arms up", "Move 2", "Spin"])
    XCTAssertEqual(makeKeyMoves(times: Array(0..<12).map { $0 * 1000 }, names: [])[11].id, "km12")
  }

  func testWarnings() {
    XCTAssertTrue(keyMoveWarnings([1000, 2000], durationMs: 15000).contains { $0.contains("8 to 16") })
    let fine = Array(1...8).map { $0 * 1500 }
    XCTAssertEqual(keyMoveWarnings(fine, durationMs: 15000), [])
    let late = fine.dropLast() + [14800]
    XCTAssertTrue(keyMoveWarnings(Array(late), durationMs: 15000).contains { $0.contains("14800") })
  }
}

final class OptionsTests: XCTestCase {
  func testDefaults() throws {
    let o = try parseOptions(["clips/Salsa Basic 01.mp4", "-o", "out.json"])
    XCTAssertEqual(o.video, "clips/Salsa Basic 01.mp4")
    XCTAssertEqual(o.out, "out.json")
    XCTAssertEqual(o.fps, 15)
    XCTAssertEqual(o.id, "salsa-basic-01")
    XCTAssertEqual(o.title, "salsa-basic-01")
    XCTAssertEqual(o.durationMs, 15000)
    XCTAssertEqual(o.startMs, 0)
    XCTAssertFalse(o.mirrored)
    XCTAssertNil(o.bpm)
    XCTAssertEqual(o.keyMoves, .omitted)
  }

  func testAllFlags() throws {
    let o = try parseOptions([
      "ref.mov", "--out", "r.json", "--fps", "30", "--id", "wave_1", "--title", "The Wave",
      "--song", "Night Drive (ElevenLabs Music)", "--bpm", "118", "--first-beat-ms", "250",
      "--key-moves", "1000, 2000,3000", "--key-move-names", "A,B,C", "--mirrored",
      "--start-ms", "4200", "--duration-ms", "15000", "--routine-version", "2",
    ])
    XCTAssertEqual(o.fps, 30)
    XCTAssertEqual(o.id, "wave_1")
    XCTAssertEqual(o.title, "The Wave")
    XCTAssertEqual(o.bpm, 118)
    XCTAssertEqual(o.firstBeatMs, 250)
    XCTAssertEqual(o.keyMoves, .list([1000, 2000, 3000]))
    XCTAssertEqual(o.keyMoveNames, ["A", "B", "C"])
    XCTAssertTrue(o.mirrored)
    XCTAssertEqual(o.startMs, 4200)
    XCTAssertEqual(o.routineVersion, 2)
    XCTAssertEqual(keyMoveTimes(o), [1000, 2000, 3000])
  }

  func testEvery() throws {
    let o = try parseOptions(["v.mp4", "-o", "o.json", "--bpm", "120", "--every", "4"])
    XCTAssertEqual(o.keyMoves, .every(4))
    XCTAssertEqual(keyMoveTimes(o), [2000, 4000, 6000, 8000, 10000, 12000, 14000])
  }

  func testErrors() {
    func bad(_ args: [String], _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
      XCTAssertThrowsError(try parseOptions(args), file: file, line: line) { e in
        XCTAssertTrue(
          "\(e)".contains(needle), "'\(e)' should mention '\(needle)'", file: file, line: line)
      }
    }
    bad([], "missing <video>")
    bad(["v.mp4"], "missing -o")
    bad(["a.mp4", "b.mp4", "-o", "o.json"], "expected one <video>")
    bad(["v.mp4", "-o"], "needs a value")
    bad(["v.mp4", "-o", "o.json", "--fps", "60"], "--fps")
    bad(["v.mp4", "-o", "o.json", "--fps", "x"], "whole number")
    bad(["v.mp4", "-o", "o.json", "--every", "4"], "needs --bpm")
    bad(["v.mp4", "-o", "o.json", "--bpm", "120", "--every", "4", "--key-moves", "1"], "not both")
    bad(["v.mp4", "-o", "o.json", "--key-moves", "1000,20000"], "outside")
    bad(["v.mp4", "-o", "o.json", "--key-moves", "1000,1000"], "duplicates")
    bad(["v.mp4", "-o", "o.json", "--id", "Bad Id"], "--id")
    bad(["v.mp4", "-o", "o.json", "--wat"], "unknown option")
    bad(["v.mp4", "-o", "o.json", "--bpm", "900"], "--bpm")
  }

  func testHelp() throws {
    XCTAssertTrue(try parseOptions(["--help"]).help)
  }

  func testSlug() {
    XCTAssertEqual(slugFromPath("/x/y/Hip-Hop  Groove!!.MOV"), "hip-hop-groove")
    XCTAssertEqual(slugFromPath("___.mp4"), "routine")
    XCTAssertEqual(slugFromPath("_a_b.mp4"), "a_b")
    XCTAssertEqual(slugFromPath("!!!.mp4"), "routine")
    XCTAssertTrue(isValidId(slugFromPath(String(repeating: "ab ", count: 40) + ".mp4")))
  }
}

final class JSONTests: XCTestCase {
  func testNumbers() {
    XCTAssertEqual(jsonNumber(0), "0")
    XCTAssertEqual(jsonNumber(1), "1")
    XCTAssertEqual(jsonNumber(0.5), "0.5")
    XCTAssertEqual(jsonNumber(0.1234567), "0.123457")
    XCTAssertEqual(jsonNumber(118), "118")
    XCTAssertEqual(jsonNumber(-0.0000001), "0")
    XCTAssertEqual(jsonNumber(.nan), "0")
  }

  func testStrings() {
    XCTAssertEqual(jsonString(#"a "b" \c"#), #""a \"b\" \\c""#)
    XCTAssertEqual(jsonString("x\ny\u{01}"), #""x\ny\u0001""#)
    XCTAssertEqual(jsonString("café"), "\"café\"")
  }

  func routine(keyMoves: [KeyMove]?) -> RoutineOutput {
    var k = [Double](repeating: 0, count: 57)
    k[0] = 0.5
    k[1] = 0.25
    k[2] = 0.9
    return RoutineOutput(
      id: "wave", version: 1, title: "The \"Wave\"", song: "Night Drive", bpm: 120,
      durationMs: 15000, firstBeatMs: 500, size: ImageSize(w: 720, h: 1280),
      frames: [RefFrame(t: 0, k: k), RefFrame(t: 67, k: k)], keyMoves: keyMoves)
  }

  func testRoutineShapeParsesAsRoutineData() throws {
    let text = renderRoutineJSON(
      routine(keyMoves: makeKeyMoves(times: [500, 2500], names: ["Arms up"])))
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    XCTAssertEqual(
      Set(obj.keys),
      [
        "schema_version", "id", "version", "title", "song", "bpm", "duration_ms", "first_beat_ms",
        "count_in_beats", "w", "h", "mirrored_source", "source", "frames", "key_moves", "media",
      ])
    XCTAssertEqual(obj["schema_version"] as? Int, 1)
    XCTAssertEqual(obj["title"] as? String, "The \"Wave\"")
    XCTAssertEqual(obj["count_in_beats"] as? Int, 3)
    XCTAssertEqual(obj["mirrored_source"] as? Bool, false)
    XCTAssertEqual(obj["source"] as? String, "vision")
    XCTAssertEqual(obj["w"] as? Int, 720)
    XCTAssertEqual(obj["h"] as? Int, 1280)
    let frames = try XCTUnwrap(obj["frames"] as? [[String: Any]])
    XCTAssertEqual(frames.count, 2)
    XCTAssertEqual(frames[1]["t"] as? Int, 67)
    let k = try XCTUnwrap(frames[0]["k"] as? [Double])
    XCTAssertEqual(k.count, 57)
    XCTAssertEqual(k[1], 0.25)
    let moves = try XCTUnwrap(obj["key_moves"] as? [[String: Any]])
    XCTAssertEqual(moves.map { $0["id"] as? String }, ["km01", "km02"])
    XCTAssertEqual(moves.map { $0["name"] as? String }, ["Arms up", "Move 2"])
    let media = try XCTUnwrap(obj["media"] as? [String: Any])
    XCTAssertTrue(media["video"] is NSNull)
    XCTAssertTrue(media["audio"] is NSNull)
  }

  func testKeyMovesLeftOutWhenNotGiven() throws {
    let text = renderRoutineJSON(routine(keyMoves: nil))
    let obj = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    XCTAssertNil(obj["key_moves"])
    XCTAssertNotNil(obj["media"])
  }
}

final class SummaryTests: XCTestCase {
  func testCountsAndWarnings() {
    var s = RunStats()
    s.sampled = 10
    s.noPerson = 1
    var k = [Double](repeating: 0, count: 57)
    for j in 0..<19 { k[3 * j + 2] = 0.9 }
    k[3 * 17 + 2] = 0  // leftAnkle absent
    for t in 0..<9 { s.add(RefFrame(t: t * 66, k: k)) }
    XCTAssertEqual(s.emitted, 9)
    XCTAssertEqual(s.absent[17], 9)
    XCTAssertEqual(s.weak[17], 9)
    XCTAssertEqual(s.weak[0], 0)
    XCTAssertEqual(s.meanConfidence, 0.9 * 18 / 19, accuracy: 1e-9)
    let out = summaryLines(s, durationMs: 15000, fps: 15)
    XCTAssertTrue(out.lines.contains { $0.contains("leftAnkle") })
    XCTAssertTrue(out.warnings.contains { $0.contains("leftAnkle") })
    XCTAssertTrue(out.warnings.contains { $0.contains("over 5%") })
    XCTAssertTrue(out.warnings.contains { $0.contains("shorter than the routine") })
  }
}
