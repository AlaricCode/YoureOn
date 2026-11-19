// Every fixed string the bet screens show, by screen, with its copy role, so one node test can
// check them all against ui/copyRule (TASKS D5-M2 crypto-copy audit). Templates with {name},
// {amount} or {n} are CONTRACT_COPY lines; fill them with the helpers below.
import type { ScanMiss } from '../app/scan';
import type { CopyRole } from '../ui/copyRule';

type Line = readonly [text: string, role: CopyRole];

export const COPY = {
  home: {
    room: ['Room', 'label'],
    roomCode: ['Room code', 'label'],
    join: ['Join room', 'label'],
    create: ['New room', 'label'],
    leave: ['Leave room', 'label'],
    empty: ['Room is empty', 'label'],
    challenge: ['Challenge', 'label'],
    offline: ['Offline', 'label'],
    scan: ['Scan a face', 'label'],
    history: ['History', 'label'],
    profile: ['Profile', 'label'],
    badCode: ['Room not found', 'error'],
    createFailed: ['Room not created', 'error'],
    challengeFailed: ['Challenge not sent', 'error'],
    pairBusy: ['Bet already open', 'error'],
    tooManyBets: ['Finish open bets', 'error'],
    notInRoom: ['Not in room', 'error'],
    slowDown: ['Try again soon', 'error'],
    joinRoomFirst: ['Join room first', 'error'],
    judgeCamFailed: ['Camera not set', 'error'],
    // The shared lobby (app/lobby): no code on screen, everyone with the app open is here.
    everyone: ['Everyone here', 'label'],
    lobbyEmpty: ['Nobody else online', 'label'],
    joining: ['Joining', 'label'],
    privateRoom: ['Private room', 'label'],
    back: ['Back', 'label'],
  },
  scan: {
    title: ['Challenge', 'label'],
    point: ['Point at someone', 'label'],
    checking: ['Checking', 'label'],
    noMatch: ['No match', 'error'],
    // Face matching only sees this room: nobody else in it means no scan can ever match.
    emptyRoom: ['Nobody else here', 'error'],
    // The lobby has no code to read out: the other phone only needs the app open.
    openApp: ['Ask them to open the app', 'body'],
    notThem: ['Not them', 'label'],
    pickList: ['Pick from list', 'label'],
    allowCamera: ['Allow camera', 'label'],
    openSettings: ['Open settings', 'label'],
    cameraNeeded: ['Camera access needed', 'error'],
    // Why a scan found nobody to address (app/scan ScanMiss), shown as the red line.
    noFace: ['No face found', 'error'],
    closer: ['Move closer', 'error'],
    scanAgain: ['Scan again', 'error'],
    joinRoom: ['Join the room', 'error'],
    slowDown: ['Slow down', 'error'],
    betOpen: ['Bet in progress', 'error'],
    failed: ['Try again', 'error'],
    // A face screen crashed (a native module missing from the build): face is off until restart.
    unavailable: ['Face scan unavailable', 'error'],
  },
  incoming: {
    accept: ['Accept', 'label'],
    decline: ['Decline', 'label'],
  },
  negotiate: {
    title: ['The judge', 'label'],
    listening: ['Listening', 'label'],
    speaking: ['Speaking', 'label'],
    micOn: ['Mic on', 'label'],
    micMuted: ['Mic muted', 'label'],
    draft: ['Draft terms', 'label'],
    readBack: ['Reading back', 'label'],
    decline: ['Back out', 'label'],
    typeIt: ['Type it instead', 'label'],
    useVoice: ['Use the judge', 'label'],
    theBet: ['The bet', 'label'],
    stake: ['Stake each', 'label'],
    send: ['Send terms', 'label'],
    lockItIn: ['Lock it in', 'label'],
    waitingTerms: ['Waiting for terms', 'label'],
    sent: ['Terms sent', 'label'],
  },
  terms: {
    title: ['Terms', 'label'],
    you: ['You', 'label'],
    counts: ['Counts if', 'label'],
    doesnt: ["Doesn't count if", 'label'],
    edge: ['Edge cases', 'label'],
    evidence: ['Evidence', 'label'],
    deadline: ['Deadline', 'label'],
    tries: ['Tries', 'label'],
    /** A Dance Off's round length on the card ("15 seconds": the routine's own length). */
    round: ['Round', 'label'],
    odds: ['Odds', 'label'],
    code: ['Terms code', 'label'],
    timeLeft: ['Time left', 'label'],
    nothingMoves: ['Nothing moves until you both lock in', 'contract'],
    checking: ['Checking', 'label'],
    refused: ["Something's off. Not signing.", 'contract'],
    faceIdFailed: ['Face ID failed', 'error'],
    locking: ['Locking', 'label'],
    locked: ['Locked', 'label'],
    decline: ['Decline', 'label'],
    backHome: ['Back home', 'label'],
    review: ['Review terms', 'label'],
    continue: ['Continue', 'label'],
    /** A tap on a swipe control (the lock, GG): it does not commit, it shows this. */
    swipeHint: ['Swipe up', 'label'],
  },
  live: {
    title: ['Bet', 'label'],
    locked: ['Locked', 'label'],
    filming: ['Filming', 'label'],
    judging: ['Judging', 'label'],
    yourTurn: ['Your turn', 'label'],
    pot: ['Pot', 'label'],
    start: ['Start', 'label'],
    noJudgeCam: ['No judge cam', 'error'],
  },
  judgeCam: {
    title: ['Judge cam', 'label'],
    standingBy: ['Standing by', 'label'],
    go: ['Go', 'label'],
    recording: ['Recording', 'label'],
    stop: ['Stop', 'label'],
    sending: ['Sending', 'label'],
    sent: ['Sent', 'label'],
    start: ['Start', 'label'],
    noCamera: ['No camera', 'error'],
  },
  ruling: {
    judge: ['Judge', 'label'],
    finalIn: ['Final in', 'label'],
    gg: ['GG', 'label'],
    appeal: ['I appeal!', 'label'],
    appealPrompt: ['Appeal the ruling', 'label'],
    tooLate: ['Too late', 'error'],
    waiting: ['Waiting', 'label'],
    tip: ['Tip', 'label'],
    ready: ['Ready', 'label'],
    paid: ['Paid', 'label'],
    paying: ['Paying', 'label'],
    payoutFailed: ['Payout failed', 'error'],
    retry: ['Try again', 'label'],
    backHome: ['Back home', 'label'],
  },
  hearing: {
    title: ['Hearing', 'label'],
    holdToTalk: ['Hold to talk', 'label'],
    talking: ['Talking', 'label'],
    next: ['Next', 'label'],
    done: ['Done', 'label'],
    now: ['Now', 'label'],
    judging: ['Judging', 'label'],
  },
  appeal: {
    title: ['Appeal', 'label'],
    voting: ['Voting', 'label'],
    upholds: ['Upholds', 'label'],
    overturns: ['Overturns', 'label'],
    abstains: ['Abstains', 'label'],
    stands: ['Ruling stands', 'label'],
    flipped: ['Ruling flipped', 'label'],
    continue: ['Continue', 'label'],
  },
  market: {
    title: ['Market', 'label'],
    price: ['Bitcoin price', 'label'],
    strike: ['Strike', 'label'],
    side: ['Your side', 'label'],
    odds: ['Odds', 'label'],
    settlesIn: ['Settles in', 'label'],
    waiting: ['Waiting for Gemini', 'label'],
    // Beat 6 on A's negotiate screen ("Bet on Bitcoin", app/marketTerms)
    open: ['Bet on Bitcoin', 'label'],
    panel: ['Bitcoin, 5 minutes', 'label'],
    up: ['Up', 'label'],
    down: ['Down', 'label'],
    stake: ['Stake each', 'label'],
    line: ['Line', 'label'],
    closesIn: ['Closes in', 'label'],
    split: ['Split', 'label'],
    propose: ['Send terms', 'label'],
    pricing: ['Getting odds', 'label'],
    back: ['Back', 'label'],
    gemini: ['Gemini', 'label'],
    settled: ['Gemini settled', 'label'],
    replay: ['Replay', 'label'],
    nextRound: ['Next round', 'label'],
  },
  // Dance Off (app/danceTerms, app/danceFlow; DANCE-OFF §6.2): the negotiate panel, the ruling
  // and the app's side of the round. The dance screens' own lines live with them (../dance).
  dance: {
    open: ['Dance off', 'label'],
    panel: ['Dance off', 'label'],
    routine: ['Routine', 'label'],
    stake: ['Stake each', 'label'],
    theBet: ['The bet', 'label'],
    propose: ['Send terms', 'label'],
    back: ['Back', 'label'],
    /** Who wrote the ruling's line (Claude checks the round; the score decides it). */
    announcer: ['Announcer', 'label'],
    /** A VOID 'undecidable' round: the scores are within the margin, or a player was missed. */
    tooClose: ['Too close to call', 'body'],
    refund: ['Both stakes go back.', 'body'],
    unknownRoutine: ['Routine not found', 'error'],
    uploadFailed: ['Upload failed', 'error'],
    roundOver: ['Round closed', 'error'],
    unavailable: ['Dance off unavailable', 'error'],
  },
  // Double or nothing (app/rematch; DANCE-OFF §7), every bet type.
  rematch: {
    button: ['Double or nothing', 'label'],
    /** B's incoming invite when it follows a finished bet (bet.invited rematch_of). */
    incoming: ['Double or nothing', 'label'],
  },
  history: {
    title: ['History', 'label'],
    empty: ['No bets yet', 'label'],
    won: ['Won', 'label'],
    lost: ['Lost', 'label'],
    voided: ['Refunded', 'label'],
    /** A seed row's title (is_seed: the head-to-head demo history). */
    demo: ['Demo history', 'label'],
  },
  profile: {
    title: ['Profile', 'label'],
    photo: ['Profile photo', 'label'],
    none: ['None', 'label'],
    face: ['Face matching', 'label'],
    on: ['On', 'label'],
    off: ['Off', 'label'],
    history: ['History', 'label'],
    judgeCam: ['Judge cam', 'label'],
    demo: ['Demo account', 'label'],
  },
  app: {
    loading: ['Loading', 'label'],
    offline: ["Can't connect", 'error'],
    failed: ['Try again', 'error'],
    crashed: ['Something went wrong', 'error'],
  },
  // Odds (app/odds, odds/*): unequal stakes the two agree on, and the judge's suggestion.
  odds: {
    title: ['Odds', 'label'],
    even: ['Even', 'label'],
    iGive: ['I give', 'label'],
    iGet: ['I get', 'label'],
    base: ['Smaller stake', 'label'],
    accept: ['Accept', 'label'],
    counter: ['Counter', 'label'],
    withdraw: ['Withdraw', 'label'],
    send: ['Send odds', 'label'],
    cancel: ['Cancel', 'label'],
    custom: ['Custom', 'label'],
    offer: ['Offer odds', 'label'],
    suggestOdds: ['Suggest odds', 'label'],
    suggesting: ['Asking the judge', 'label'],
    judgesOdds: ["Judge's odds", 'label'],
    oddsAgreed: ['Odds agreed', 'label'],
    demoHistory: ['Demo history', 'label'],
    byDefault: ['Default odds', 'label'],
    pending: ['Agree the odds first.', 'body'],
    changed: ['The odds changed. Look again.', 'body'],
    tooLong: ['Ten to one, tops. Pick shorter odds.', 'body'],
  },
  demo: {
    title: ['Demo account', 'label'],
    scan: ['Scan stage code', 'label'],
    checking: ['Checking', 'label'],
    done: ['Signed in', 'label'],
    badCode: ['Code expired', 'error'],
    continue: ['Continue', 'label'],
    useLink: ['Use this account', 'label'],
  },
  // "Call it off" (app/callOff, screens/CallOff): a mutual stop of a locked bet, both refunded.
  callOff: {
    button: ['Call it off', 'label'],
    confirmTitle: ['Call it off?', 'label'],
    keepPlaying: ['Keep playing', 'label'],
    agree: ['Agree', 'label'],
    refundBoth: ['Both of you get your money back.', 'body'],
    failed: ['Not called off', 'error'],
  },
} as const satisfies Record<string, Record<string, Line>>;

export const t = (line: Line): string => line[0];

/** The red line for each scan miss (1-3 words; "No match" is the friendly abstain line). */
export const SCAN_MISS_COPY: Readonly<Record<ScanMiss, Line>> = {
  no_face: COPY.scan.noFace,
  too_far: COPY.scan.closer,
  no_match: COPY.scan.noMatch,
  expired: COPY.scan.scanAgain,
  not_in_room: COPY.scan.joinRoom,
  busy: COPY.scan.slowDown,
  pair_busy: COPY.scan.betOpen,
  failed: COPY.scan.failed,
};

/** CONTRACT_COPY fillers (ui/copyRule). */
export const fill = {
  challenged: (name: string) => `${name} challenged you`,
  challengeName: (name: string) => `Challenge ${name}?`,
  /** The scan screen in an empty room: the other phone must join this room first. */
  joinCode: (code: string) => `Have them join room ${code}`,
  holdToLock: (amount: string) => `Hold to lock in ${amount}`,
  swipeToLock: (amount: string) => `Swipe up to lock in ${amount}`,
  youreIn: (name: string) => `You're in. Waiting for ${name}…`,
  theyreIn: (name: string) => `${name} is in`,
  headToHead: (w: number, l: number, name: string, net: string) =>
    `You're ${w}-${l} against ${name} (${net})`,
  turn: (name: string) => `${name}'s turn`,
  /** A's typed terms are on the card; B has not accepted yet. First name only: a 3-word label. */
  waitingFor: (name: string) => `Waiting for ${name.trim().split(/\s+/)[0] || 'them'}`,
  /** An odds offer is out: the other side has not tapped Accept yet. First name only. */
  waitingOn: (name: string) => `Waiting on ${name.trim().split(/\s+/)[0] || 'them'}`,
  /** The judge's offer header: "Judge suggests 3:1" (compact ratio keeps it a 3-word label). */
  judgeSuggests: (ratio: string) => `Judge suggests ${ratio}`,
  /** "31% for Jake" under the judge's odds. First name only. */
  chanceFor: (pct: number, name: string) => `${pct}% for ${name.trim().split(/\s+/)[0] || 'them'}`,
  /** A routine card's tempo: "120 bpm" (data). */
  bpm: (bpm: number) => `${Math.round(bpm)} bpm`,
  /** A routine card's tempo and length: "120 bpm · 15s" (data; each routine has its own). */
  routineMeta: (bpm: number, seconds: number) => `${Math.round(bpm)} bpm · ${seconds}s`,
  /**
   * The call-off copy takes the party's on-screen label as it is (../app/callOff callOffLabels:
   * the first name, or first name + initial when both share one, the Dance Off's naming).
   * The confirm sheet's body (body copy).
   */
  callOffBody: (label: string) =>
    `Both of you get your money back. ${label.trim() || 'They'} has to agree.`,
  /** The other phone's prompt (contract copy, ui/copyRule). */
  callOffAsk: (label: string) => `${label.trim() || 'They'} wants to call it off. Refund both?`,
  /** The asker's corner while the other phone decides (contract copy: "Sim A" is two words). */
  callOffWaiting: (label: string) => `Waiting for ${label.trim() || 'them'}`,
  /** The asker's note when the other phone tapped Keep playing (contract copy). */
  keptPlaying: (label: string) => `${label.trim() || 'They'} wants to keep playing`,
} as const;
