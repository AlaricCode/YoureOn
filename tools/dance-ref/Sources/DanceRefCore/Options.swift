import Foundation

public enum KeyMoveSpec: Equatable, Sendable {
  /// No key moves in the JSON; `scripts/dance-routine.ts import` picks beats.
  case omitted
  /// `--key-moves ms,ms,…`
  case list([Int])
  /// `--every K` (needs `--bpm`; anchored on `--first-beat-ms`)
  case every(Int)
}

public struct Options: Equatable, Sendable {
  public var video: String = ""
  public var out: String = ""
  public var fps: Int = 15
  public var id: String = ""
  public var title: String = ""
  public var song: String = ""
  public var bpm: Double? = nil
  public var firstBeatMs: Int = 0
  public var routineVersion: Int = 1
  public var keyMoves: KeyMoveSpec = .omitted
  public var keyMoveNames: [String] = []
  public var mirrored: Bool = false
  public var startMs: Int = 0
  public var durationMs: Int = 15000
  public var help: Bool = false

  public init() {}
}

public struct UsageError: Error, Equatable, CustomStringConvertible {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var description: String { message }
}

public let USAGE = """
  usage: dance-ref <video> -o <out.json> [options]

    -o, --out <path>          output RoutineData JSON (float keypoints; import it with
                              npx tsx scripts/dance-routine.ts import <out.json>)
    --fps <n>                 analysis rate, 1..30 (default 15)
    --id <slug>               routine id, kebab case [a-z0-9] words joined by single '-',
                              max 32 (default: from the video file name)
    --title <text>            routine title, max 40 characters (default: the id)
    --song <text>             song / track credit, max 80 characters (default: Unnamed track)
    --bpm <n>                 tempo of the track (default 120, with a warning)
    --first-beat-ms <ms>      first beat, ms after the routine start (default 0)
    --routine-version <n>     RoutineData.version (default 1)
    --key-moves <ms,ms,...>   key move times, ms after the routine start
    --every <K>               or: a key move every K beats from --first-beat-ms
    --key-move-names <a,b,..> optional names for the key moves, in time order
    --mirrored                the source is mirrored (selfie style): flip x and swap left/right
    --start-ms <ms>           routine start inside the video (default 0)
    --duration-ms <ms>        routine length (default 15000; the contract requires 15000)
    -h, --help                show this help
  """

/// Same rule as shared `RoutineId` (`/^[a-z0-9]+(-[a-z0-9]+)*$/`, max 32) and the Terms routine
/// line, so every id the tool writes passes `RoutineData.parse` on import.
let ID_PATTERN = #"^[a-z0-9]+(?:-[a-z0-9]+)*\z"#
public let ID_MAX = 32
public let TITLE_MAX = 40
public let SONG_MAX = 80
public let DEFAULT_SONG = "Unnamed track"

public func isValidId(_ id: String) -> Bool {
  id.count <= ID_MAX && id.range(of: ID_PATTERN, options: .regularExpression) != nil
}

/// "Salsa Basic 01.mp4" → "salsa-basic-01"; "my_dance.mov" → "my-dance" (kebab case, max 32)
public func slugFromPath(_ path: String) -> String {
  let base = (path as NSString).lastPathComponent
  let stem = (base as NSString).deletingPathExtension.lowercased()
  var out = ""
  var dash = false
  for ch in stem {
    if ch.isASCII && (ch.isLetter || ch.isNumber) {
      out.append(ch)
      dash = false
    } else if !dash && !out.isEmpty {
      out.append("-")
      dash = true
    }
  }
  if out.count > ID_MAX { out = String(out.prefix(ID_MAX)) }
  while out.hasSuffix("-") { out.removeLast() }
  return out.isEmpty ? "routine" : out
}

func intArg(_ flag: String, _ v: String) throws -> Int {
  guard let n = Int(v.trimmingCharacters(in: .whitespaces)) else {
    throw UsageError("\(flag) needs a whole number, got '\(v)'")
  }
  return n
}

func doubleArg(_ flag: String, _ v: String) throws -> Double {
  guard let n = Double(v.trimmingCharacters(in: .whitespaces)), n.isFinite else {
    throw UsageError("\(flag) needs a number, got '\(v)'")
  }
  return n
}

func listArg(_ v: String) -> [String] {
  v.split(separator: ",", omittingEmptySubsequences: true).map {
    String($0).trimmingCharacters(in: .whitespaces)
  }.filter { !$0.isEmpty }
}

/// Parses the CLI arguments (without the program name). Throws `UsageError` with a message.
public func parseOptions(_ args: [String]) throws -> Options {
  var o = Options()
  var positional: [String] = []
  var keyList: [Int]? = nil
  var every: Int? = nil
  var i = 0

  func value(_ flag: String) throws -> String {
    guard i + 1 < args.count else { throw UsageError("\(flag) needs a value") }
    i += 1
    return args[i]
  }

  while i < args.count {
    let a = args[i]
    switch a {
    case "-h", "--help": o.help = true
    case "-o", "--out": o.out = try value(a)
    case "--fps": o.fps = try intArg(a, try value(a))
    case "--id": o.id = try value(a)
    case "--title": o.title = try value(a)
    case "--song": o.song = try value(a)
    case "--bpm": o.bpm = try doubleArg(a, try value(a))
    case "--first-beat-ms": o.firstBeatMs = try intArg(a, try value(a))
    case "--routine-version": o.routineVersion = try intArg(a, try value(a))
    case "--key-moves":
      keyList = try listArg(try value(a)).map { try intArg(a, $0) }
    case "--every": every = try intArg(a, try value(a))
    case "--key-move-names": o.keyMoveNames = listArg(try value(a))
    case "--mirrored": o.mirrored = true
    case "--start-ms": o.startMs = try intArg(a, try value(a))
    case "--duration-ms": o.durationMs = try intArg(a, try value(a))
    default:
      if a.hasPrefix("-") && a.count > 1 { throw UsageError("unknown option \(a)") }
      positional.append(a)
    }
    i += 1
  }

  if o.help { return o }

  guard positional.count == 1, let video = positional.first else {
    throw UsageError(
      positional.isEmpty ? "missing <video>" : "expected one <video>, got \(positional.count)")
  }
  o.video = video
  guard !o.out.isEmpty else { throw UsageError("missing -o <out.json>") }
  guard (1...30).contains(o.fps) else { throw UsageError("--fps must be 1..30") }
  guard o.startMs >= 0 else { throw UsageError("--start-ms must be >= 0") }
  guard o.durationMs >= 1000 && o.durationMs <= 60000 else {
    throw UsageError("--duration-ms must be 1000..60000")
  }
  guard o.firstBeatMs >= 0 && o.firstBeatMs < o.durationMs else {
    throw UsageError("--first-beat-ms must be inside the routine (0..duration)")
  }
  guard o.routineVersion >= 1 else { throw UsageError("--routine-version must be >= 1") }
  if let bpm = o.bpm, !(bpm >= 40 && bpm <= 240) {
    throw UsageError("--bpm must be 40..240")
  }

  if o.id.isEmpty { o.id = slugFromPath(video) }
  guard isValidId(o.id) else {
    throw UsageError(
      "--id must be kebab case like wave-pop ([a-z0-9] words joined by single '-',"
        + " max \(ID_MAX)), got '\(o.id)'")
  }
  if o.title.isEmpty { o.title = String(o.id.prefix(TITLE_MAX)) }
  guard o.title.count <= TITLE_MAX else {
    throw UsageError("--title must be at most \(TITLE_MAX) characters")
  }
  if o.song.isEmpty { o.song = DEFAULT_SONG }
  guard o.song.count <= SONG_MAX else {
    throw UsageError("--song must be at most \(SONG_MAX) characters")
  }

  switch (keyList, every) {
  case (.some(_), .some(_)):
    throw UsageError("use either --key-moves or --every, not both")
  case (.some(let list), nil):
    guard !list.isEmpty else { throw UsageError("--key-moves is empty") }
    for t in list where t < 0 || t >= o.durationMs {
      throw UsageError("key move \(t) ms is outside the routine (0..\(o.durationMs - 1))")
    }
    guard Set(list).count == list.count else { throw UsageError("--key-moves has duplicates") }
    o.keyMoves = .list(list)
  case (nil, .some(let k)):
    guard k >= 1 else { throw UsageError("--every must be >= 1") }
    guard o.bpm != nil else { throw UsageError("--every needs --bpm") }
    o.keyMoves = .every(k)
  case (nil, nil):
    o.keyMoves = .omitted
  }
  return o
}

/// The key move times the options ask for (empty for `.omitted`).
public func keyMoveTimes(_ o: Options) -> [Int] {
  switch o.keyMoves {
  case .omitted: return []
  case .list(let l): return l.sorted()
  case .every(let k):
    return everyKBeats(
      bpm: o.bpm ?? DEFAULT_BPM, firstBeatMs: o.firstBeatMs, every: k, durationMs: o.durationMs)
  }
}

public let DEFAULT_BPM = 120.0
