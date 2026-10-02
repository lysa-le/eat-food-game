import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getFaceLandmarker } from '../vision/faceLandmarker'
import {
  ChompDetector,
  computeJawOpenScore,
  computeFaceWidth,
  computeMouthCenter,
  filterBackgroundFaces,
  TwoPlayerTracker,
} from '../vision/mouthChomp'
import type { FoodItem, ResolvedFood } from '../game/food'
import {
  computeLevel,
  computeMouthHitRadius,
  FoodManager,
  getAllSpriteUrls,
} from '../game/food'
import {
  formatScore,
  type HighScoreEntry,
  insertHighScore,
  MAX_HIGH_SCORE_ENTRIES,
} from '../game/highScore'
import {
  playBonusEat,
  playGameOver,
  playGoodEat,
  playHazardHit,
  playLevelUp,
} from '../audio/sfx'
import {
  computeCoverCropRect,
  drawVideoCover,
  remapNormalizedPoint,
} from '../utils/drawVideoCover'
import { getSprite, preloadSprites } from '../utils/spriteCache'
import {
  fetchGlobalTopScores,
  isGlobalLeaderboardConfigured,
  submitGlobalScore,
} from '../game/globalLeaderboard'
import {
  isOnlineAvailable,
  otherRole,
  publishPlayerState,
  takeRoomIdFromUrl,
  watchPlayerState,
  type PlayerState,
} from '../game/onlineRoom'
import { friendStakesText, onlineMatchResult } from '../game/onlineStakes'
import {
  OnlineLobby,
  type LobbyRole,
  type OnlineSession,
} from './OnlineLobby'
import './CameraStage.css'

// Preload every food/hazard sprite as soon as this module loads, so
// they're ready (or nearly ready) by the time gameplay starts.
preloadSprites(getAllSpriteUrls())

type Status =
  | 'requesting-camera'
  | 'loading-model'
  | 'running'
  | 'no-face'
  | 'error'

type Screen = 'start' | 'playing' | 'paused' | 'game-over'

/** 'together' ("1 Player" in the menu): one shared score/lives — plays
 * solo, but a friend who leans into frame joins automatically as
 * Player 2. 'versus' ("2 Player"): two independent games side by side,
 * split down the middle, each with their own score/level/lives. */
type GameMode = 'together' | 'versus'

/** How long a second face must stay in frame before it counts as
 * Player 2 joining — filters out one-frame spurious detections. */
const PLAYER_JOIN_CONFIRM_MS = 500
/** How long the "Player 2 joined!" banner stays up. */
const PLAYER_JOIN_BANNER_MS = 2500
/** How long no face must be detected before "Center yourself in frame"
 * shows — tracking drops a frame or two on fast moves, which shouldn't
 * flash the banner. */
const NO_FACE_SHOW_DELAY_MS = 750
/** Once shown, the banner stays at least this long so it's readable,
 * even if the face is found again right away. */
const NO_FACE_MIN_VISIBLE_MS = 1500

interface PopEffect {
  x: number
  y: number
  startedAt: number
}

interface GameControls {
  startGame: () => void
  pauseGame: () => void
  resumeGame: () => void
  returnToMenu: () => void
  submitInitials: (initials: string) => void
  selectGameMode: (mode: GameMode) => void
  setOnlineSession: (session: OnlineSession | null) => void
  /** Online: both players are out — move on to the end screen. */
  finishOnlineRound: () => void
}

const INITIALS_MAX_LENGTH = 3

/** Set when the page was opened from a friend's online-game link. Read
 * once at module load: takeRoomIdFromUrl strips it from the URL. */
const initialGuestRoomId = takeRoomIdFromUrl()

/** Which part of the start menu is showing (only while screen is
 * 'start'): the main menu, the 2 Player choice, or the online lobby. */
type MenuView = 'main' | 'two-player' | 'online'

/** Online: at most one update to the room per player this often (a
 * life lost or game over is sent immediately). Keeps each player's doc
 * near Firestore's ~1 write/second guideline. */
const ONLINE_SEND_INTERVAL_MS = 500
/** Online: each phone also re-sends its state this often ("still here"),
 * so a friend who isn't scoring doesn't look like they've left. */
const ONLINE_HEARTBEAT_MS = 5000
/** Online, out first: no word from the friend for this long means they've
 * left (closed the app, lost signal). */
const FRIEND_LEFT_AFTER_MS = 30000

/** Seconds counted down before an online game starts on both phones. */
const ONLINE_COUNTDOWN_SECONDS = 3

/** Face tracking's first frames after the model loads are very slow
 * while the GPU warms up (several seconds on an iPad) — long enough to
 * freeze the page, skip a countdown and miss the first chomps. Tracking
 * only counts as ready once this many frames in a row each finish under
 * WARMUP_FRAME_MS, or after WARMUP_MAX_MS so a slow device never gets
 * stuck on "Loading…". */
const WARMUP_SMOOTH_FRAMES = 10
const WARMUP_FRAME_MS = 80
const WARMUP_MAX_MS = 12000
const HEART_ICON_URL = `${import.meta.env.BASE_URL}heart pixel art/heart pixel art 32x32.png`

/**
 * Renders the classic arcade "enter your initials" widget: three
 * underlined slots with a blinking cursor in the next-to-fill one, so
 * the 3-character limit is visually obvious. A real (invisible) text
 * input sits on top to capture actual keystrokes/paste/mobile keyboards
 * — the slots are purely a visual readout of its value.
 */
function InitialsSlots({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <span className="camera-stage__initials-slots">
      {Array.from({ length: INITIALS_MAX_LENGTH }, (_, i) => {
        const isCursor = i === value.length
        return (
          <span key={i} className="camera-stage__initials-slot">
            <span
              className={
                isCursor
                  ? 'camera-stage__initials-char camera-stage__initials-char--cursor'
                  : 'camera-stage__initials-char'
              }
            >
              {value[i] ?? (isCursor ? '_' : '')}
            </span>
          </span>
        )
      })}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, INITIALS_MAX_LENGTH))}
        maxLength={INITIALS_MAX_LENGTH}
        autoFocus
        className="camera-stage__initials-hidden-input"
      />
    </span>
  )
}

/**
 * Points broken down by category — shown only on the game-over screen
 * (not during live play) so the moment-to-moment HUD stays lighter;
 * this is a "how did I get here" explanation, not something you need to
 * track second-to-second.
 */
function ScoreBreakdown({
  goodPoints,
  junkPoints,
}: {
  goodPoints: number
  junkPoints: number
}) {
  return (
    <div className="camera-stage__breakdown">
      <div className="camera-stage__breakdown-row">
        <span>Food</span>
        <span>
          {goodPoints >= 0 ? '+' : ''}
          {goodPoints}
        </span>
      </div>
      <div className="camera-stage__breakdown-row">
        <span>Junk</span>
        <span>
          {junkPoints >= 0 ? '+' : ''}
          {junkPoints}
        </span>
      </div>
    </div>
  )
}

/**
 * 80s-arcade-style top-5 list: "1. ABC 004200", blank/000000 for empty
 * slots. When editValue is passed, the highlighted row's initials render
 * as a live text input instead of static text — for entering initials
 * right in place on a fresh high score, like a real arcade cabinet.
 */
function HighScoreBoard({
  entries,
  highlightIndex,
  editValue,
  onEditChange,
}: {
  entries: HighScoreEntry[]
  highlightIndex: number | null
  editValue?: string
  onEditChange?: (value: string) => void
}) {
  const rows = Array.from(
    { length: MAX_HIGH_SCORE_ENTRIES },
    (_, i): HighScoreEntry => entries[i] ?? { initials: '', score: 0 },
  )
  return (
    <ol className="camera-stage__leaderboard">
      {rows.map((entry, i) => {
        const highlighted = i === highlightIndex
        const editing = highlighted && editValue !== undefined
        return (
          <li
            key={i}
            className={[
              'camera-stage__leaderboard-row',
              highlighted && 'camera-stage__leaderboard-row--highlight',
              editing && 'camera-stage__leaderboard-row--editing',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="camera-stage__leaderboard-rank">{i + 1}.</span>
            {editing ? (
              <InitialsSlots
                value={editValue}
                onChange={onEditChange ?? (() => {})}
              />
            ) : (
              <span className="camera-stage__leaderboard-initials">
                {entry.initials}
              </span>
            )}
            <span className="camera-stage__leaderboard-score">
              {formatScore(entry.score)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * One player's box in a two-player game: Same Screen (Player 1 / Player
 * 2) or Online (You / Friend). p1 is orange on the left, p2 green on the
 * right. When that player is out, "Game Over" replaces their hearts.
 */
function PlayerPanel({
  side,
  label,
  score,
  level,
  lives,
  out,
}: {
  side: 'p1' | 'p2'
  label: string
  score: number
  level: number
  lives: number
  out: boolean
}) {
  return (
    <div className={`camera-stage__side-hud camera-stage__side-hud--${side}`}>
      <div className="camera-stage__side-hud-label">{label}</div>
      <div className="camera-stage__score-row">
        <span>Score</span>
        <span className="camera-stage__score-value">{score}</span>
      </div>
      <div className="camera-stage__score-row camera-stage__hud-divider">
        <span>Lv</span>
        <span className="camera-stage__level-value">{level}</span>
      </div>
      {out ? (
        <div className="camera-stage__side-hud-gameover">Game Over</div>
      ) : (
        <div className="camera-stage__side-hud-lives">
          {Array.from({ length: STARTING_LIVES }, (_, i) => (
            <img
              key={i}
              src={HEART_ICON_URL}
              alt={i < lives ? 'Life' : 'Lost life'}
              className={
                i < lives
                  ? 'camera-stage__heart-icon camera-stage__heart-icon--small'
                  : 'camera-stage__heart-icon camera-stage__heart-icon--small camera-stage__heart-icon--empty'
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

const POP_EFFECT_LIFETIME_MS = 400
const STARTING_LIVES = 3
const INVINCIBILITY_MS = 1200

/**
 * Pause/resume glyph drawn as SVG rather than the ⏸/▶ characters, which
 * iOS renders as color emoji. Orange fill (currentColor) with the same
 * dark-blue outline + offset drop shadow as the title text.
 */
function PauseButtonIcon({ paused }: { paused: boolean }) {
  const shapes = paused ? (
    <polygon points="7,4 19,12 7,20" />
  ) : (
    <>
      <rect x="5" y="4" width="5" height="16" />
      <rect x="14" y="4" width="5" height="16" />
    </>
  )
  return (
    <svg
      className="camera-stage__pause-icon"
      viewBox="-1 -1 28 28"
      aria-hidden="true"
    >
      <g fill="#1e1b4b" transform="translate(2 2)">
        {shapes}
      </g>
      <g fill="currentColor" stroke="#1e1b4b" strokeWidth="1.5">
        {shapes}
      </g>
    </svg>
  )
}

/**
 * One player's independent game state in versus (split-screen) mode.
 * Mirrors the same "closure variables are the source of truth, React
 * state is just a display mirror" pattern used for together mode's
 * score/level/lives — see handleEatenForSide.
 */
interface SideRuntime {
  foodManager: FoodManager
  eatenCount: number
  currentLevel: number
  invincibleUntil: number
  score: number
  goodPoints: number
  junkPoints: number
  lives: number
  isGameOver: boolean
}

function createSideRuntime(xRange: [number, number]): SideRuntime {
  return {
    foodManager: new FoodManager({ xRange }),
    eatenCount: 0,
    currentLevel: 1,
    invincibleUntil: 0,
    score: 0,
    goodPoints: 0,
    junkPoints: 0,
    lives: STARTING_LIVES,
    isGameOver: false,
  }
}

function resetSideRuntime(runtime: SideRuntime): void {
  runtime.foodManager.reset()
  runtime.eatenCount = 0
  runtime.currentLevel = 1
  runtime.invincibleUntil = 0
  runtime.score = 0
  runtime.goodPoints = 0
  runtime.junkPoints = 0
  runtime.lives = STARTING_LIVES
  runtime.isGameOver = false
}

/** React-state mirror of a SideRuntime, for rendering. */
interface SideDisplayState {
  score: number
  goodPoints: number
  junkPoints: number
  level: number
  lives: number
  gameOver: boolean
}

function snapshotSide(runtime: SideRuntime): SideDisplayState {
  return {
    score: runtime.score,
    goodPoints: runtime.goodPoints,
    junkPoints: runtime.junkPoints,
    level: runtime.currentLevel,
    lives: runtime.lives,
    gameOver: runtime.isGameOver,
  }
}

const INITIAL_SIDE_DISPLAY: SideDisplayState = {
  score: 0,
  goodPoints: 0,
  junkPoints: 0,
  level: 1,
  lives: STARTING_LIVES,
  gameOver: false,
}

/** Retriggers a flash overlay's CSS animation from the start. */
function triggerFlash(el: HTMLDivElement | null): void {
  if (!el) return
  el.classList.remove('camera-stage__flash--active')
  void el.offsetWidth
  el.classList.add('camera-stage__flash--active')
}

/**
 * Draws a labeled circle at a player's mouth position with their live
 * jaw-open score — shown only once a second player joins, so a solo
 * player's screen is unaffected. Helps two players tell which mouth is
 * being tracked as which of them.
 */
function drawPlayerDebugMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  jawOpenScore: number,
  color: string,
): void {
  ctx.beginPath()
  ctx.arc(x, y, 30, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.stroke()

  ctx.save()
  // Counter the canvas's CSS mirror (scaleX(-1)) so this text reads
  // correctly instead of backwards.
  ctx.translate(x, y - 40)
  ctx.scale(-1, 1)
  ctx.font = '14px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(`${label} ${jawOpenScore.toFixed(2)}`, 0, 0)
  ctx.restore()
}

export function CameraStage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chompFlashRef = useRef<HTMLDivElement>(null)
  const hazardFlashRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const subtitleFirstLineRef = useRef<HTMLSpanElement>(null)
  const controlsRef = useRef<GameControls>({
    startGame: () => {},
    pauseGame: () => {},
    resumeGame: () => {},
    returnToMenu: () => {},
    submitInitials: () => {},
    selectGameMode: () => {},
    setOnlineSession: () => {},
    finishOnlineRound: () => {},
  })
  const [status, setStatus] = useState<Status>('requesting-camera')
  const [errorMessage, setErrorMessage] = useState('')
  const [score, setScore] = useState(0)
  // Points broken down by category, so the player can see how the score
  // is made up. Bonus items fold into "good" here — they're still food,
  // just a rare/high-value kind, and this stays a two-line summary.
  const [goodPoints, setGoodPoints] = useState(0)
  const [junkPoints, setJunkPoints] = useState(0)
  const [level, setLevel] = useState(1)
  const [lives, setLives] = useState(STARTING_LIVES)
  const [screen, setScreen] = useState<Screen>('start')
  const [gameMode, setGameMode] = useState<GameMode>('together')
  const [showJoinBanner, setShowJoinBanner] = useState(false)
  const [menuView, setMenuView] = useState<MenuView>(
    initialGuestRoomId ? 'online' : 'main',
  )
  const [lobbyRole, setLobbyRole] = useState<LobbyRole | null>(
    initialGuestRoomId ? { kind: 'guest', roomId: initialGuestRoomId } : null,
  )
  // countdownEndsAt (performance.now() ms) drives the countdown; the
  // shown number is derived from it, so a stalled frame can delay the
  // display but never skip or bunch up the numbers.
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [trackingWarm, setTrackingWarm] = useState(false)
  // Set while playing online: which room, and which side this phone is.
  const [onlineSession, setOnlineSessionState] =
    useState<OnlineSession | null>(null)
  // The other phone's live game, for the Friend box.
  const [friendState, setFriendState] = useState<PlayerState | null>(null)
  // Online: you're out of lives but your friend is still playing.
  const [selfOut, setSelfOut] = useState(false)
  // Online: when the friend's state last arrived (Date.now() ms), and
  // whether they've gone quiet long enough to count as gone.
  const [friendSeenAt, setFriendSeenAt] = useState(0)
  const [friendLeft, setFriendLeft] = useState(false)
  const [side1, setSide1] = useState<SideDisplayState>(INITIAL_SIDE_DISPLAY)
  const [side2, setSide2] = useState<SideDisplayState>(INITIAL_SIDE_DISPLAY)
  const [versusWinner, setVersusWinner] = useState<
    'p1' | 'p2' | 'tie' | null
  >(null)
  const [globalRank, setGlobalRank] = useState<number | null>(null)
  const [globalScoreSubmitted, setGlobalScoreSubmitted] = useState(false)
  const [initialsInput, setInitialsInput] = useState('')
  const [globalScores, setGlobalScores] = useState<HighScoreEntry[]>([])
  // Mirror of globalScores readable from inside the mount-once game
  // effect. The initial fetch resolves *after* that effect has started,
  // so a plain snapshot there would be stuck at [] and every score
  // would rank as a "new high score".
  const globalScoresRef = useRef<HighScoreEntry[]>([])
  const applyGlobalScores = (entries: HighScoreEntry[]) => {
    globalScoresRef.current = entries
    setGlobalScores(entries)
  }

  const refreshGlobalScores = () => {
    if (!isGlobalLeaderboardConfigured()) return
    fetchGlobalTopScores(MAX_HIGH_SCORE_ENTRIES).then(applyGlobalScores)
  }

  // Global board is entirely optional — see .env.example. Nothing here
  // runs (and the UI never renders it) unless a real Firebase project is
  // configured.
  useEffect(() => {
    refreshGlobalScores()
  }, [])

  // Size the title to exactly span the subtitle's first line, rather than
  // guessing a font-size — the two use different sizes of the same pixel
  // font, so scaling the title's measured width to match the subtitle's
  // measured width keeps them aligned regardless of window size or when
  // the web font finishes loading.
  useLayoutEffect(() => {
    const syncTitleSize = () => {
      const title = titleRef.current
      const target = subtitleFirstLineRef.current
      if (!title || !target) return
      const targetWidth = target.offsetWidth
      const currentWidth = title.offsetWidth
      if (targetWidth === 0 || currentWidth === 0) return
      const currentFontSize = parseFloat(getComputedStyle(title).fontSize)
      title.style.fontSize = `${(currentFontSize * targetWidth) / currentWidth}px`
    }
    syncTitleSize()
    window.addEventListener('resize', syncTitleSize)
    document.fonts?.ready.then(syncTitleSize)
    return () => window.removeEventListener('resize', syncTitleSize)
  }, [])

  useEffect(() => {
    let cancelled = false
    let rafId = 0
    let renderLoop: (() => void) | null = null
    let stream: MediaStream | null = null
    let lastVideoTime = -1
    const chompDetector1 = new ChompDetector()
    const chompDetector2 = new ChompDetector()
    const playerTracker = new TwoPlayerTracker()
    const foodManager = new FoodManager()
    // Player 1's zone is the *internal* canvas right half (xFrac 0.5-1):
    // the whole canvas is CSS-mirrored for display, so that's what ends
    // up on the LEFT of the screen — matching where Player 1 (the
    // screen-left face, per TwoPlayerTracker) actually sits.
    const side1Runtime = createSideRuntime([0.5, 1])
    const side2Runtime = createSideRuntime([0, 0.5])
    const popEffects: PopEffect[] = []
    let handleResize: (() => void) | null = null
    let eatenCount = 0
    let currentLevel = 1
    let livesRemaining = STARTING_LIVES
    let invincibleUntil = 0
    let scoreTotal = 0
    let pendingEntryIndex: number | null = null
    let screenLocal: Screen = 'start'
    let gameModeLocal: GameMode = 'together'
    // Whether a second player has joined this game (1 Player mode only).
    // Drives the join banner and the leaderboard's solo/together tag.
    let secondPlayerJoined = false
    let secondFaceSince: number | null = null
    // "Center yourself in frame" banner timing (wall-clock ms).
    let faceMissingSince: number | null = null
    let noFaceShownAt: number | null = null
    const updateFacePresence = (faceFound: boolean, at: number) => {
      if (faceFound) {
        faceMissingSince = null
        if (
          noFaceShownAt === null ||
          at - noFaceShownAt >= NO_FACE_MIN_VISIBLE_MS
        ) {
          noFaceShownAt = null
          setStatus('running')
        }
        return
      }
      faceMissingSince ??= at
      if (
        noFaceShownAt === null &&
        at - faceMissingSince >= NO_FACE_SHOW_DELAY_MS
      ) {
        noFaceShownAt = at
        setStatus('no-face')
      }
    }
    let joinBannerTimer: ReturnType<typeof setTimeout> | undefined
    // Online 2 Player: this phone's room/side, and throttled sending of
    // its score/lives/level to the friend's Friend box.
    let onlineLocal: OnlineSession | null = null
    // Online: out of lives, waiting on the dimmed play screen while the
    // friend finishes (no chomps, no new food).
    let selfOutOnline = false
    let lastPublishAt = 0
    let publishTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    const publishOnline = (urgent: boolean) => {
      if (!onlineLocal) return
      const send = () => {
        publishTimer = undefined
        if (!onlineLocal) return
        lastPublishAt = performance.now()
        publishPlayerState(onlineLocal.roomId, onlineLocal.role, {
          score: scoreTotal,
          lives: Math.max(0, livesRemaining),
          level: currentLevel,
          out: livesRemaining <= 0,
        }).catch((err) => console.error('Failed to send online state', err))
      }
      const wait = urgent
        ? 0
        : Math.max(0, ONLINE_SEND_INTERVAL_MS - (performance.now() - lastPublishAt))
      if (wait === 0) {
        clearTimeout(publishTimer)
        send()
      } else if (publishTimer === undefined) {
        publishTimer = setTimeout(send, wait)
      }
    }
    const finishOnlineRound = () => {
      clearInterval(heartbeatTimer)
      if (screenLocal !== 'playing') return
      screenLocal = 'game-over'
      setScreen('game-over')
    }
    const setOnlineSession = (session: OnlineSession | null) => {
      onlineLocal = session
      clearTimeout(publishTimer)
      publishTimer = undefined
      clearInterval(heartbeatTimer)
      if (session) {
        heartbeatTimer = setInterval(() => publishOnline(true), ONLINE_HEARTBEAT_MS)
      }
      setOnlineSessionState(session)
    }
    // Pausing halts the render loop entirely, but performance.now() keeps
    // advancing with real wall-clock time regardless. Without this offset,
    // every spawn/expiry/invincibility timestamp (all scheduled against
    // performance.now()) would look like it's due the instant you resume
    // from a long pause, dumping/expiring everything at once.
    let pausedAccumulatedMs = 0
    let pauseStartedAt = 0

    const startGame = () => {
      if (screenLocal !== 'start') return
      screenLocal = 'playing'
      setScreen('playing')
      // Fill the friend's Friend box straight away (score 0, full lives).
      publishOnline(true)
    }

    const pauseGame = () => {
      if (screenLocal !== 'playing') return
      screenLocal = 'paused'
      setScreen('paused')
      pauseStartedAt = performance.now()
      cancelAnimationFrame(rafId)
    }

    const resumeGame = () => {
      if (screenLocal !== 'paused') return
      pausedAccumulatedMs += performance.now() - pauseStartedAt
      screenLocal = 'playing'
      setScreen('playing')
      if (renderLoop) rafId = requestAnimationFrame(renderLoop)
    }

    /** Clears all game state and goes back to the start menu. */
    const returnToMenu = () => {
      foodManager.reset()
      playerTracker.reset()
      popEffects.length = 0
      eatenCount = 0
      currentLevel = 1
      livesRemaining = STARTING_LIVES
      invincibleUntil = 0
      scoreTotal = 0
      pendingEntryIndex = null
      secondPlayerJoined = false
      secondFaceSince = null
      clearTimeout(joinBannerTimer)
      setShowJoinBanner(false)
      setOnlineSession(null)
      selfOutOnline = false
      setSelfOut(false)
      screenLocal = 'start'
      setScore(0)
      setGoodPoints(0)
      setJunkPoints(0)
      setLevel(1)
      setLives(STARTING_LIVES)
      setGlobalRank(null)
      setGlobalScoreSubmitted(false)
      setInitialsInput('')

      resetSideRuntime(side1Runtime)
      resetSideRuntime(side2Runtime)
      setSide1(snapshotSide(side1Runtime))
      setSide2(snapshotSide(side2Runtime))
      setVersusWinner(null)

      setScreen('start')
    }

    const selectGameMode = (mode: GameMode) => {
      if (screenLocal !== 'start') return
      gameModeLocal = mode
      setGameMode(mode)
    }

    const submitInitials = (initials: string) => {
      if (pendingEntryIndex === null) return
      const updated = [...globalScoresRef.current]
      updated[pendingEntryIndex] = {
        ...updated[pendingEntryIndex],
        initials: initials.slice(0, INITIALS_MAX_LENGTH),
      }
      // Optimistic local preview — replaced by the real server list once
      // submitGlobalScore's write lands and refreshGlobalScores refetches.
      applyGlobalScores(updated)
      setGlobalScoreSubmitted(true)
      submitGlobalScore(
        updated[pendingEntryIndex],
        onlineLocal ? 'versus' : secondPlayerJoined ? 'together' : 'solo',
      ).then(refreshGlobalScores)
      // Saving ends the round — the start menu's leaderboard already shows
      // the new entry (from the optimistic update above).
      returnToMenu()
    }

    controlsRef.current = {
      startGame,
      pauseGame,
      resumeGame,
      returnToMenu,
      submitInitials,
      selectGameMode,
      setOnlineSession,
      finishOnlineRound,
    }

    async function start() {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        })
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not access the camera.',
        )
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      video.srcObject = stream
      await video.play()

      await new Promise<void>((resolve) => {
        if (video.readyState >= 2) {
          resolve()
        } else {
          video.addEventListener('loadeddata', () => resolve(), {
            once: true,
          })
        }
      })
      if (cancelled) return

      // Canvas pixel space always equals the actual viewport size — video
      // is cropped into that space (see drawVideoCover), not scaled up to
      // it via CSS — so anything drawn at any (x, y) within canvas bounds
      // is guaranteed visible, and stays that way across a window resize.
      handleResize = () => {
        canvas.width = window.innerWidth
        canvas.height = window.innerHeight
        foodManager.setCanvasSize(canvas.width, canvas.height)
        side1Runtime.foodManager.setCanvasSize(canvas.width, canvas.height)
        side2Runtime.foodManager.setCanvasSize(canvas.width, canvas.height)
      }
      handleResize()
      window.addEventListener('resize', handleResize)

      setStatus('loading-model')
      const faceLandmarker = await getFaceLandmarker()
      if (cancelled) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      setStatus('running')

      const trackingStartedAt = performance.now()
      let smoothFrames = 0
      let warm = false

      /** Team mode: any player's chomp eats from the same shared pool. */
      const handleEatenFood = (eaten: FoodItem | null, now: number): void => {
        if (!eaten) return

        if (eaten.category === 'hazard') {
          if (now < invincibleUntil) return
          livesRemaining -= 1
          invincibleUntil = now + INVINCIBILITY_MS
          setLives(livesRemaining)
          playHazardHit()
          triggerFlash(hazardFlashRef.current)
          publishOnline(true)

          if (livesRemaining <= 0) {
            if (onlineLocal) {
              // Stay on the (dimmed) play screen until the friend is out
              // too — see finishOnlineRound.
              selfOutOnline = true
              setSelfOut(true)
            } else {
              screenLocal = 'game-over'
              setScreen('game-over')
            }

            // Checked against the global board only — there's no local
            // fallback board anymore. Nothing is actually written to
            // Firestore until the player confirms initials (see
            // submitInitials); this is just a local, optimistic preview
            // of where the score *would* land.
            if (isGlobalLeaderboardConfigured()) {
              const newEntry: HighScoreEntry = { initials: '', score: scoreTotal }
              const updated = insertHighScore(globalScoresRef.current, newEntry)
              const rank = updated.findIndex((e) => e === newEntry)
              if (rank !== -1) {
                pendingEntryIndex = rank
                applyGlobalScores(updated)
              }
              setGlobalRank(rank !== -1 ? rank : null)
            }
            playGameOver()
          }
          return
        }

        eatenCount += 1
        scoreTotal += eaten.points
        setScore((s) => s + eaten.points)
        if (eaten.category === 'junk') {
          setJunkPoints((p) => p + eaten.points)
        } else {
          setGoodPoints((p) => p + eaten.points)
        }

        if (eaten.category === 'good' || eaten.category === 'junk') {
          playGoodEat()
        } else if (eaten.category === 'bonus') {
          playBonusEat()
        }

        popEffects.push({
          x: eaten.xFrac * canvas.width,
          y: eaten.yFrac * canvas.height,
          startedAt: now,
        })

        const newLevel = computeLevel(eatenCount)
        if (newLevel !== currentLevel) {
          currentLevel = newLevel
          setLevel(currentLevel)
          playLevelUp()
        }
        publishOnline(false)
      }

      // Dev-only test hook (stripped from production builds): lets a
      // headless browser, whose fake camera can't chomp, score points or
      // lose lives in 1 Player / Online games.
      if (import.meta.env.DEV) {
        const fakeFood = (category: FoodItem['category'], points: number) =>
          ({ id: -1, category, points, xFrac: 0.5, yFrac: 0.5, spawnedAt: 0, expiresAt: null, sprite: '' }) as unknown as FoodItem
        Object.assign(window, {
          __eatFoodDebug: {
            addPoints: (points: number) =>
              handleEatenFood(fakeFood('good', points), performance.now()),
            loseLife: () =>
              handleEatenFood(
                fakeFood('hazard', 0),
                Math.max(invincibleUntil, performance.now()),
              ),
          },
        })
      }

      /**
       * Versus mode: each side has fully independent score/lives — one
       * side running out doesn't stop the other. The round only ends
       * once *both* sides are game-over, at which point the higher
       * score wins.
       */
      const handleEatenForSide = (
        side: 1 | 2,
        eaten: FoodItem | null,
        now: number,
      ): void => {
        const runtime = side === 1 ? side1Runtime : side2Runtime
        const setSide = side === 1 ? setSide1 : setSide2
        if (!eaten || runtime.isGameOver) return

        if (eaten.category === 'hazard') {
          if (now < runtime.invincibleUntil) return
          runtime.invincibleUntil = now + INVINCIBILITY_MS
          runtime.lives -= 1
          playHazardHit()
          triggerFlash(hazardFlashRef.current)

          if (runtime.lives <= 0) {
            runtime.isGameOver = true
            const other = side === 1 ? side2Runtime : side1Runtime
            if (other.isGameOver) {
              screenLocal = 'game-over'
              setScreen('game-over')
              setVersusWinner(
                side1Runtime.score === side2Runtime.score
                  ? 'tie'
                  : side1Runtime.score > side2Runtime.score
                    ? 'p1'
                    : 'p2',
              )
              playGameOver()
            }
          }
          setSide(snapshotSide(runtime))
          return
        }

        runtime.eatenCount += 1
        runtime.score += eaten.points
        if (eaten.category === 'junk') {
          runtime.junkPoints += eaten.points
        } else {
          runtime.goodPoints += eaten.points
        }

        if (eaten.category === 'good' || eaten.category === 'junk') {
          playGoodEat()
        } else if (eaten.category === 'bonus') {
          playBonusEat()
        }

        popEffects.push({
          x: eaten.xFrac * canvas.width,
          y: eaten.yFrac * canvas.height,
          startedAt: now,
        })

        const newLevel = computeLevel(runtime.eatenCount)
        if (newLevel !== runtime.currentLevel) {
          runtime.currentLevel = newLevel
          playLevelUp()
        }

        setSide(snapshotSide(runtime))
      }

      /**
       * Versus mode: a chomp always credits the *eating player's own*
       * score, no matter which zone's pool the food came from or which
       * side of the screen they're currently standing on. Each zone
       * still spawns its own food (for visual variety / a "home turf"),
       * but a player can walk over and steal from the other pool — the
       * credit follows them, not the zone. Searches both zones' active
       * food for the closest edible item, then removes it from whichever
       * FoodManager actually owns it.
       */
      const tryEatAcrossZones = (
        mouthX: number,
        mouthY: number,
        mouthRadius: number,
      ): FoodItem | null => {
        let closest: ResolvedFood | null = null
        let closestDist = Infinity
        for (const food of [
          ...side1Runtime.foodManager.getActiveFoods(),
          ...side2Runtime.foodManager.getActiveFoods(),
        ]) {
          const dist = Math.hypot(mouthX - food.x, mouthY - food.y)
          if (dist <= mouthRadius + food.radius && dist < closestDist) {
            closestDist = dist
            closest = food
          }
        }
        if (!closest) return null
        return (
          side1Runtime.foodManager.removeById(closest.id) ??
          side2Runtime.foodManager.removeById(closest.id)
        )
      }

      const loop = (): void => {
        if (cancelled) return

        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime
          const rawNow = performance.now()
          const now = rawNow - pausedAccumulatedMs
          const result = faceLandmarker.detectForVideo(video, rawNow)
          if (!warm) {
            const frameMs = performance.now() - rawNow
            smoothFrames = frameMs < WARMUP_FRAME_MS ? smoothFrames + 1 : 0
            if (
              smoothFrames >= WARMUP_SMOOTH_FRAMES ||
              performance.now() - trackingStartedAt >= WARMUP_MAX_MS
            ) {
              warm = true
              setTrackingWarm(true)
            }
          }

          if (screenLocal === 'playing') {
            if (gameModeLocal !== 'versus') {
              if (!selfOutOnline) foodManager.update(now, currentLevel)
            } else {
              if (!side1Runtime.isGameOver) {
                side1Runtime.foodManager.update(now, side1Runtime.currentLevel)
              }
              if (!side2Runtime.isGameOver) {
                side2Runtime.foodManager.update(now, side2Runtime.currentLevel)
              }
            }
          }
          const mouthHitRadius = computeMouthHitRadius(
            canvas.width,
            canvas.height,
          )

          const cropRect = computeCoverCropRect(
            video,
            canvas.width,
            canvas.height,
          )

          ctx.save()
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          drawVideoCover(ctx, video, canvas.width, canvas.height, cropRect)

          // Team co-op: track up to 2 faces, each with its own chomp
          // detector, both eating from the same shared FoodManager/
          // score/lives. TwoPlayerTracker keeps "Player 1"/"Player 2"
          // identity stable across frames (matched by proximity to each
          // player's last known position) rather than re-sorting by
          // position every frame, which would let identity flip when
          // players move relative to each other.
          // Drop faces far in the background (much smaller than the
          // closest face) before assigning players, so a bystander
          // walking past can't join or chomp.
          const playableIndices = filterBackgroundFaces(
            result.faceLandmarks.map(computeFaceWidth),
          )
          const faces = playableIndices.map((index) => {
            const faceLandmarks = result.faceLandmarks[index]
            const mouthNorm = computeMouthCenter(faceLandmarks)
            const mouthCropped = remapNormalizedPoint(
              mouthNorm.x,
              mouthNorm.y,
              video,
              cropRect,
            )
            return {
              mouthX: mouthCropped.x * canvas.width,
              mouthY: mouthCropped.y * canvas.height,
              jawOpenScore: computeJawOpenScore(result.faceBlendshapes[index]),
            }
          })

          const [p1Index, p2Index] = playerTracker.assign(
            faces.map((f) => ({ x: f.mouthX, y: f.mouthY })),
          )
          // Online is one player per phone: track only them (whichever
          // slot the tracker parked them in) and ignore anyone else.
          const player1Index = onlineLocal ? (p1Index ?? p2Index) : p1Index
          const player1 = player1Index !== null ? faces[player1Index] : null
          const player2 =
            p2Index !== null && !onlineLocal ? faces[p2Index] : null

          // 1 Player mode: announce Player 2 once a second face has
          // stayed in frame long enough to be a real person.
          if (
            gameModeLocal === 'together' &&
            screenLocal === 'playing' &&
            !secondPlayerJoined
          ) {
            if (player1 && player2) {
              secondFaceSince ??= now
              if (now - secondFaceSince >= PLAYER_JOIN_CONFIRM_MS) {
                secondPlayerJoined = true
                setShowJoinBanner(true)
                joinBannerTimer = setTimeout(
                  () => setShowJoinBanner(false),
                  PLAYER_JOIN_BANNER_MS,
                )
              }
            } else {
              secondFaceSince = null
            }
          }

          updateFacePresence(Boolean(player1 || player2), rawNow)

          if (player1 || player2) {
            // Only show the P1/P2 markers once a second player actually
            // joins — a solo player's screen stays exactly as before.
            const showMarkers = Boolean(player1 && player2)

            const processPlayer = (
              face: { mouthX: number; mouthY: number; jawOpenScore: number },
              detector: ChompDetector,
              identitySide: 1 | 2,
              label: string,
              color: string,
            ) => {
              if (
                detector.update(face.jawOpenScore, now) &&
                screenLocal === 'playing'
              ) {
                triggerFlash(chompFlashRef.current)
                if (gameModeLocal !== 'versus') {
                  const eaten = foodManager.tryEat(
                    face.mouthX,
                    face.mouthY,
                    mouthHitRadius,
                  )
                  handleEatenFood(eaten, now)
                } else {
                  const eaten = tryEatAcrossZones(
                    face.mouthX,
                    face.mouthY,
                    mouthHitRadius,
                  )
                  handleEatenForSide(identitySide, eaten, now)
                }
              }
              if (showMarkers) {
                drawPlayerDebugMarker(
                  ctx,
                  face.mouthX,
                  face.mouthY,
                  label,
                  face.jawOpenScore,
                  color,
                )
              }
            }

            // Once a side is out in versus mode, its chomp detection is
            // fully deactivated — not just barred from scoring — so that
            // player can't keep grabbing food out of play (denying it to
            // the other player) after they're done.
            const p1Active =
              !selfOutOnline &&
              (gameModeLocal !== 'versus' || !side1Runtime.isGameOver)
            const p2Active =
              gameModeLocal !== 'versus' || !side2Runtime.isGameOver

            if (player1 && p1Active) {
              processPlayer(player1, chompDetector1, 1, 'P1', '#38bdf8')
            }
            if (player2 && p2Active) {
              processPlayer(player2, chompDetector2, 2, 'P2', '#f472b6')
            }
          }

          if (screenLocal === 'playing') {
            // Crisp nearest-neighbor scaling for the pixel-art sprites —
            // reset automatically by the ctx.restore() below, so this
            // never affects the (smooth) video draw on other frames.
            ctx.imageSmoothingEnabled = false
            const activeFoods =
              gameModeLocal !== 'versus'
                ? foodManager.getActiveFoods()
                : [
                    ...(side1Runtime.isGameOver
                      ? []
                      : side1Runtime.foodManager.getActiveFoods()),
                    ...(side2Runtime.isGameOver
                      ? []
                      : side2Runtime.foodManager.getActiveFoods()),
                  ]
            for (const food of activeFoods) {
              const sprite = getSprite(food.sprite)
              if (sprite.complete && sprite.naturalWidth > 0) {
                // Source art isn't uniform resolution or aspect ratio
                // across packs — read each sprite's real dimensions
                // rather than assuming. Genuinely low-res art (16px) gets
                // a smaller target *and* snapped to an integer multiple,
                // since non-integer scaling of so few source pixels reads
                // as blurry; higher-res art has enough detail that
                // scaling straight to the shared target (so it visually
                // matches everything else) doesn't look soft.
                const nativeWidth = sprite.naturalWidth
                const nativeHeight = sprite.naturalHeight
                const nativeMax = Math.max(nativeWidth, nativeHeight)
                const isLowRes = nativeMax <= 16
                const targetSize = food.radius * (isLowRes ? 1.1 : 1.7)
                const scale = isLowRes
                  ? Math.max(1, Math.round(targetSize / nativeMax))
                  : targetSize / nativeMax
                const drawWidth = nativeWidth * scale
                const drawHeight = nativeHeight * scale
                ctx.drawImage(
                  sprite,
                  food.x - drawWidth / 2,
                  food.y - drawHeight / 2,
                  drawWidth,
                  drawHeight,
                )
              }

              if (food.category === 'bonus') {
                const badgeX = food.x + food.radius * 0.15
                const badgeY = food.y - food.radius * 0.15
                ctx.save()
                // The whole canvas is CSS-mirrored (scaleX(-1)) for
                // display, which flips any text drawn on it backwards.
                // Counter-flip locally around the badge's own position so
                // it reads correctly once the outer mirror is applied.
                ctx.translate(badgeX, badgeY)
                ctx.scale(-1, 1)
                ctx.font = `${food.radius * 0.6}px "Press Start 2P", ui-monospace, monospace`
                ctx.lineWidth = 3
                ctx.strokeStyle = '#0f172a'
                ctx.strokeText(`+${food.points}`, 0, 0)
                ctx.fillStyle = '#facc15'
                ctx.fillText(`+${food.points}`, 0, 0)
                ctx.restore()
              }
            }
          }

          for (let i = popEffects.length - 1; i >= 0; i -= 1) {
            const effect = popEffects[i]
            const age = now - effect.startedAt
            if (age >= POP_EFFECT_LIFETIME_MS) {
              popEffects.splice(i, 1)
              continue
            }
            const progress = age / POP_EFFECT_LIFETIME_MS
            ctx.beginPath()
            ctx.arc(effect.x, effect.y, 20 + progress * 40, 0, Math.PI * 2)
            ctx.strokeStyle = `rgba(163, 230, 53, ${1 - progress})`
            ctx.lineWidth = 3
            ctx.stroke()
          }

          ctx.restore()
        }

        rafId = requestAnimationFrame(loop)
      }

      renderLoop = loop
      rafId = requestAnimationFrame(loop)
    }

    start()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      clearTimeout(joinBannerTimer)
      clearTimeout(publishTimer)
      clearInterval(heartbeatTimer)
      stream?.getTracks().forEach((track) => track.stop())
      if (handleResize) window.removeEventListener('resize', handleResize)
    }
    // This effect sets up the camera/game session exactly once and must
    // not re-run when the board updates mid-game — it reads the board
    // via globalScoresRef instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cameraReady =
    (status === 'running' || status === 'no-face') && trackingWarm

  const backToMainMenu = () => {
    setLobbyRole(null)
    setMenuView('main')
  }

  const startSameScreen = () => {
    controlsRef.current.selectGameMode('versus')
    controlsRef.current.startGame()
  }

  const openOnlineLobby = () => {
    setLobbyRole({ kind: 'host' })
    setMenuView('online')
  }

  // Online: both phones get here when the room flips to 'started'. Each
  // phone then plays its own 1 Player game after the countdown.
  const beginOnlineCountdown = (session: OnlineSession) => {
    setFriendState(null)
    setFriendSeenAt(Date.now())
    setFriendLeft(false)
    controlsRef.current.setOnlineSession(session)
    controlsRef.current.selectGameMode('together')
    setLobbyRole(null)
    setMenuView('main')
    setCountdownEndsAt(performance.now() + ONLINE_COUNTDOWN_SECONDS * 1000)
    setCountdown(ONLINE_COUNTDOWN_SECONDS)
  }

  useEffect(() => {
    if (selfOut && friendState?.out) controlsRef.current.finishOnlineRound()
  }, [selfOut, friendState?.out])

  useEffect(() => {
    if (!onlineSession) return
    return watchPlayerState(
      onlineSession.roomId,
      otherRole(onlineSession.role),
      (state) => {
        setFriendState(state)
        if (state) setFriendSeenAt(Date.now())
      },
    )
  }, [onlineSession])

  // Out first and waiting: if the friend goes quiet for 30s, they've left.
  useEffect(() => {
    if (!selfOut || friendState?.out) {
      setFriendLeft(false)
      return
    }
    const check = () =>
      setFriendLeft(Date.now() - friendSeenAt >= FRIEND_LEFT_AFTER_MS)
    check()
    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [selfOut, friendState?.out, friendSeenAt])

  useEffect(() => {
    if (countdownEndsAt === null) return
    const tick = () => {
      const msLeft = countdownEndsAt - performance.now()
      if (msLeft <= 0) {
        setCountdownEndsAt(null)
        setCountdown(null)
        controlsRef.current.startGame()
      } else {
        setCountdown(Math.ceil(msLeft / 1000))
      }
    }
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [countdownEndsAt])

  return (
    <div className="camera-stage">
      <video ref={videoRef} className="camera-stage__video" playsInline muted />
      <canvas ref={canvasRef} className="camera-stage__canvas" />
      <div ref={chompFlashRef} className="camera-stage__flash" />
      <div
        ref={hazardFlashRef}
        className="camera-stage__flash camera-stage__flash--hazard"
      />

      {/* Online, out first: dim the play area (the boxes stay bright on
          top) and say your friend is still going. */}
      {selfOut && screen === 'playing' && (
        <>
          <div className="camera-stage__dim" />
          {friendLeft ? (
            <div className="camera-stage__hud camera-stage__hud--top camera-stage__hud--below-panels camera-stage__hud--interactive">
              <p>Friend has left the game</p>
              <button
                type="button"
                className="camera-stage__hud-button"
                onClick={() => controlsRef.current.returnToMenu()}
              >
                Return to menu
              </button>
            </div>
          ) : (
            <div className="camera-stage__hud camera-stage__hud--top camera-stage__hud--below-panels">
              <p>Friend is still playing</p>
              <p className="camera-stage__hud-stakes">
                {friendStakesText(score, friendState?.score ?? 0)}
              </p>
            </div>
          )}
        </>
      )}

      {/* Like the versus side HUDs, hidden on the start menu. Online
          games use the You / Friend boxes instead. */}
      {gameMode !== 'versus' && !onlineSession && screen !== 'start' && (
        <>
          <div className="camera-stage__score">
            <div className="camera-stage__score-row camera-stage__top-score camera-stage__hud-divider">
              <span>Top</span>
              <span className="camera-stage__score-value">
                {globalScores[0]?.score ?? 0}
              </span>
            </div>

            <div className="camera-stage__score-row">
              <span>Score</span>
              <span className="camera-stage__score-value">{score}</span>
            </div>
          </div>

          <div className="camera-stage__level-box">
            <div className="camera-stage__score-row camera-stage__hud-divider">
              <span>Level</span>
              <span className="camera-stage__level-value">{level}</span>
            </div>
            <div className="camera-stage__level-lives">
              {Array.from({ length: STARTING_LIVES }, (_, i) => (
                <img
                  key={i}
                  src={HEART_ICON_URL}
                  alt={i < lives ? 'Life' : 'Lost life'}
                  className={
                    i < lives
                      ? 'camera-stage__heart-icon camera-stage__heart-icon--small'
                      : 'camera-stage__heart-icon camera-stage__heart-icon--small camera-stage__heart-icon--empty'
                  }
                />
              ))}
            </div>
          </div>
        </>
      )}

      {gameMode === 'versus' && screen !== 'start' && (
        <>
          <PlayerPanel
            side="p1"
            label="Player 1"
            score={side1.score}
            level={side1.level}
            lives={side1.lives}
            out={side1.gameOver && screen === 'playing'}
          />
          <PlayerPanel
            side="p2"
            label="Player 2"
            score={side2.score}
            level={side2.level}
            lives={side2.lives}
            out={side2.gameOver && screen === 'playing'}
          />
        </>
      )}

      {/* Online 2 Player: your game on the left, your friend's (live from
          their phone) on the right — the same boxes as Same Screen. */}
      {onlineSession && screen !== 'start' && (
        <>
          <PlayerPanel
            side="p1"
            label="You"
            score={score}
            level={level}
            lives={lives}
            out={selfOut}
          />
          <PlayerPanel
            side="p2"
            label="Friend"
            score={friendState?.score ?? 0}
            level={friendState?.level ?? 1}
            lives={friendState?.lives ?? STARTING_LIVES}
            out={friendState?.out ?? false}
          />
        </>
      )}

      {(screen === 'playing' || screen === 'paused') && !selfOut && (
        <button
          type="button"
          className="camera-stage__pause-button"
          onClick={() =>
            screen === 'playing'
              ? controlsRef.current.pauseGame()
              : controlsRef.current.resumeGame()
          }
          aria-label={screen === 'playing' ? 'Pause' : 'Resume'}
        >
          <PauseButtonIcon paused={screen === 'paused'} />
        </button>
      )}

      {screen === 'start' && countdown !== null && (
        <div className="camera-stage__overlay">
          <p className="camera-stage__countdown">{countdown}</p>
        </div>
      )}

      {screen === 'start' && countdown === null && menuView === 'two-player' && (
        <div className="camera-stage__overlay">
          <h1>2 Player</h1>
          <div className="camera-stage__mode-select">
            {isOnlineAvailable() && (
              <button
                type="button"
                className="camera-stage__mode-button"
                onClick={openOnlineLobby}
              >
                Online
              </button>
            )}
            <button
              type="button"
              className="camera-stage__mode-button"
              disabled={!cameraReady}
              onClick={startSameScreen}
            >
              {cameraReady ? 'Same Screen' : 'Loading…'}
            </button>
          </div>
          <button
            type="button"
            className="camera-stage__action-button camera-stage__secondary-button"
            onClick={backToMainMenu}
          >
            Cancel
          </button>
        </div>
      )}

      {screen === 'start' && countdown === null && menuView === 'online' && lobbyRole && (
        <div className="camera-stage__overlay">
          <OnlineLobby
            role={lobbyRole}
            cameraReady={cameraReady}
            onStart={beginOnlineCountdown}
            onExit={backToMainMenu}
          />
        </div>
      )}

      {screen === 'start' && countdown === null && menuView === 'main' && (
        <div className="camera-stage__overlay">
          <h1 ref={titleRef} className="camera-stage__title">
            Eat Food
          </h1>
          <p className="camera-stage__overlay-subtitle">
            <span ref={subtitleFirstLineRef}>
              Open your mouth wide to chomp fruit &amp; veggies.
            </span>
            <br />
            Avoid junk food and hazards!
          </p>
          {isGlobalLeaderboardConfigured() && (
            <HighScoreBoard entries={globalScores} highlightIndex={null} />
          )}

          <div className="camera-stage__mode-select">
            <button
              type="button"
              className="camera-stage__mode-button camera-stage__mode-button--active"
            >
              1 Player
            </button>
            <button
              type="button"
              className="camera-stage__mode-button"
              onClick={() => setMenuView('two-player')}
            >
              2 Player
            </button>
          </div>

          <button
            type="button"
            disabled={!cameraReady}
            onClick={() => {
              controlsRef.current.selectGameMode('together')
              controlsRef.current.startGame()
            }}
          >
            {cameraReady ? 'Start' : 'Loading…'}
          </button>
        </div>
      )}

      {screen === 'paused' && (
        <div className="camera-stage__overlay">
          <h1>Paused</h1>
        </div>
      )}

      {/* Online result: who won, both players ranked, then (if you made
          it) your top-5 initials. */}
      {screen === 'game-over' && onlineSession && (() => {
        const result = onlineMatchResult(
          onlineSession.role,
          { score, level },
          { score: friendState?.score ?? 0, level: friendState?.level ?? 1 },
        )
        return (
          <div className="camera-stage__overlay camera-stage__overlay--game-over">
            <h1>Game Over</h1>
            <p className="camera-stage__high-score">{result.headline}</p>
            <ol className="camera-stage__leaderboard camera-stage__match-ranking">
              {result.rows.map((row) => (
                <li
                  key={row.playerNumber}
                  className={
                    row.isYou
                      ? 'camera-stage__leaderboard-row camera-stage__leaderboard-row--you'
                      : 'camera-stage__leaderboard-row'
                  }
                >
                  <span className="camera-stage__leaderboard-rank">{row.rank}.</span>
                  <span className="camera-stage__leaderboard-initials">
                    Player {row.playerNumber}
                  </span>
                  <span className="camera-stage__match-level">Lv {row.level}</span>
                  <span className="camera-stage__leaderboard-score">
                    {formatScore(row.score)}
                  </span>
                </li>
              ))}
            </ol>
            {isGlobalLeaderboardConfigured() &&
              globalRank !== null &&
              !globalScoreSubmitted && (
                <form
                  className="camera-stage__initials-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    controlsRef.current.submitInitials(initialsInput)
                  }}
                >
                  <HighScoreBoard
                    entries={globalScores}
                    highlightIndex={globalRank}
                    editValue={initialsInput}
                    onEditChange={setInitialsInput}
                  />
                  <button type="submit" className="camera-stage__action-button">
                    Save
                  </button>
                </form>
              )}
            <button
              type="button"
              className="camera-stage__action-button camera-stage__secondary-button"
              onClick={() => controlsRef.current.returnToMenu()}
            >
              Return to menu
            </button>
          </div>
        )
      })()}

      {screen === 'game-over' && gameMode !== 'versus' && !onlineSession && (
        <div className="camera-stage__overlay camera-stage__overlay--game-over">
          <h1>Game Over</h1>
          {/* Only a #1 finish gets a headline — any other top-5 finish is
              already obvious from the blinking initials row below. */}
          {isGlobalLeaderboardConfigured() && globalRank === 0 && (
            <p className="camera-stage__high-score">New high score!</p>
          )}
          <p>Final score: {score}</p>
          <ScoreBreakdown goodPoints={goodPoints} junkPoints={junkPoints} />
          {isGlobalLeaderboardConfigured() && (
            <>
              {globalRank !== null && !globalScoreSubmitted ? (
                <form
                  className="camera-stage__initials-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    controlsRef.current.submitInitials(initialsInput)
                  }}
                >
                  <HighScoreBoard
                    entries={globalScores}
                    highlightIndex={globalRank}
                    editValue={initialsInput}
                    onEditChange={setInitialsInput}
                  />
                  <button type="submit" className="camera-stage__action-button">
                    Save
                  </button>
                </form>
              ) : (
                <HighScoreBoard
                  entries={globalScores}
                  highlightIndex={globalRank}
                />
              )}
            </>
          )}
          <button
            type="button"
            className="camera-stage__action-button camera-stage__secondary-button"
            onClick={() => controlsRef.current.returnToMenu()}
          >
            Return to menu
          </button>
        </div>
      )}

      {screen === 'game-over' && gameMode === 'versus' && (
        <div className="camera-stage__overlay camera-stage__overlay--game-over">
          <h1>Game Over</h1>
          <p className="camera-stage__versus-winner-status">
            {versusWinner === 'tie'
              ? "It's a Tie!"
              : versusWinner === 'p1'
                ? 'Player 1 Wins!'
                : 'Player 2 Wins!'}
          </p>
          <div className="camera-stage__versus-result">
            <div
              className={
                versusWinner === 'p2'
                  ? 'camera-stage__versus-result-side camera-stage__versus-result-side--p1 camera-stage__versus-result-side--loser'
                  : 'camera-stage__versus-result-side camera-stage__versus-result-side--p1'
              }
            >
              <div>Player 1</div>
              <div className="camera-stage__score-value">{side1.score}</div>
              <ScoreBreakdown
                goodPoints={side1.goodPoints}
                junkPoints={side1.junkPoints}
              />
            </div>
            <div
              className={
                versusWinner === 'p1'
                  ? 'camera-stage__versus-result-side camera-stage__versus-result-side--p2 camera-stage__versus-result-side--loser'
                  : 'camera-stage__versus-result-side camera-stage__versus-result-side--p2'
              }
            >
              <div>Player 2</div>
              <div className="camera-stage__score-value">{side2.score}</div>
              <ScoreBreakdown
                goodPoints={side2.goodPoints}
                junkPoints={side2.junkPoints}
              />
            </div>
          </div>
          <button
            type="button"
            className="camera-stage__action-button camera-stage__secondary-button"
            onClick={() => controlsRef.current.returnToMenu()}
          >
            Return to menu
          </button>
        </div>
      )}

      {/* Once out online, your framing no longer matters. */}
      {status !== 'running' && !selfOut && (
        <div className="camera-stage__hud">
          {status === 'requesting-camera' && <p>Requesting camera access…</p>}
          {status === 'loading-model' && <p>Loading face tracking model…</p>}
          {status === 'no-face' && <p>Center yourself in frame</p>}
          {status === 'error' && (
            <p className="camera-stage__error">
              Camera error: {errorMessage}
            </p>
          )}
        </div>
      )}

      {showJoinBanner && screen === 'playing' && (
        <div className="camera-stage__hud camera-stage__hud--top">
          <p>Player 2 joined!</p>
        </div>
      )}

      {(screen === 'start' || screen === 'game-over') && (
        <div className="camera-stage__credit">Created by George Le</div>
      )}
    </div>
  )
}
