import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  closeRoom,
  createRoom,
  joinRoom,
  leaveRoom,
  roomLink,
  startRoom,
  watchRoom,
  type PlayerRole,
  type RoomStatus,
} from '../game/onlineRoom'

/** The room this phone is playing in, and which side it is. */
export interface OnlineSession {
  roomId: string
  role: PlayerRole
}

export type LobbyRole = { kind: 'host' } | { kind: 'guest'; roomId: string }

interface OnlineLobbyProps {
  role: LobbyRole
  /** The guest only joins once its own camera/face tracking is ready, so
   * the host can't start a game the guest isn't able to play yet. */
  cameraReady: boolean
  /** Both phones call this when the room flips to 'started'. */
  onStart: (session: OnlineSession) => void
  /** Back to the main menu (Cancel / Leave / room gone). */
  onExit: () => void
}

/** Online 2 Player setup screen, rendered inside the start overlay. */
export function OnlineLobby(props: OnlineLobbyProps) {
  return props.role.kind === 'host' ? (
    <HostLobby {...props} />
  ) : (
    <GuestLobby {...props} roomId={props.role.roomId} />
  )
}

/** Phones (and Safari) have a native share sheet; most desktop browsers
 * don't, so the button falls back to copying the link. */
const canShare = typeof navigator !== 'undefined' && 'share' in navigator

function HostLobby({ cameraReady, onStart, onExit }: OnlineLobbyProps) {
  const [roomId, setRoomId] = useState<string | null>(null)
  const [status, setStatus] = useState<RoomStatus | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let createdId: string | null = null
    let unsubscribe: (() => void) | undefined
    createRoom()
      .then((id) => {
        createdId = id
        // Unmounted (or StrictMode's dev double-run) before the room was
        // created — close it rather than leave an orphan behind.
        if (cancelled) {
          void closeRoom(id)
          return
        }
        setRoomId(id)
        QRCode.toDataURL(roomLink(id), {
          margin: 1,
          width: 360,
          color: { dark: '#1e1b4b', light: '#ffffff' },
        }).then(setQrUrl)
        unsubscribe = watchRoom(id, (next) => {
          setStatus(next)
          if (next === 'started' && !startedRef.current) {
            startedRef.current = true
            onStart({ roomId: id, role: 'host' })
          }
        })
      })
      .catch((err) => {
        console.error('Failed to create room', err)
        if (!cancelled) setError("Couldn't create a room. Check your connection.")
      })
    return () => {
      cancelled = true
      unsubscribe?.()
      if (createdId && !startedRef.current) void closeRoom(createdId)
    }
    // onStart is stable for the lifetime of this lobby.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shareLink = async () => {
    if (!roomId) return
    const url = roomLink(roomId)
    if (canShare) {
      try {
        await navigator.share({ title: 'Eat Food', text: 'Play Eat Food with me!', url })
      } catch {
        // Share sheet dismissed — nothing to do.
      }
      return
    }
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const guestJoined = status === 'ready'

  return (
    <>
      <h1>2 Player Online</h1>
      {error ? (
        <p className="camera-stage__lobby-status">{error}</p>
      ) : (
        <>
          <p className="camera-stage__overlay-subtitle">
            Have your friend scan this or open your link
          </p>
          <div className="camera-stage__lobby-qr">
            {qrUrl ? (
              <img src={qrUrl} alt="QR code for the game link" />
            ) : (
              <span>Creating room…</span>
            )}
          </div>
          <button
            type="button"
            className="camera-stage__action-button"
            disabled={!roomId}
            onClick={shareLink}
          >
            {copied ? 'Link copied!' : canShare ? 'Share link' : 'Copy link'}
          </button>
          <p
            className={
              guestJoined
                ? 'camera-stage__lobby-status camera-stage__lobby-status--ready'
                : 'camera-stage__lobby-status'
            }
          >
            {guestJoined ? 'Player 2 joined ✓' : 'Player 2: waiting…'}
          </p>
          <button
            type="button"
            className="camera-stage__action-button"
            disabled={!guestJoined || !cameraReady || !roomId || starting}
            onClick={() => {
              if (!roomId) return
              setStarting(true)
              setStartError(null)
              // The countdown starts from the server-confirmed "started"
              // (watchRoom), never from this tap alone.
              startRoom(roomId).catch((err) => {
                console.error('Failed to start the game', err)
                setStarting(false)
                setStartError(
                  "Couldn't start the game. Close and reopen the app to update it, then try again.",
                )
              })
            }}
          >
            {starting ? 'Starting…' : 'Start'}
          </button>
          {startError && <p className="camera-stage__lobby-status">{startError}</p>}
        </>
      )}
      <button
        type="button"
        className="camera-stage__action-button camera-stage__secondary-button"
        onClick={onExit}
      >
        Cancel
      </button>
    </>
  )
}

function GuestLobby({
  roomId,
  cameraReady,
  onStart,
  onExit,
}: OnlineLobbyProps & { roomId: string }) {
  const [status, setStatus] = useState<RoomStatus | null | undefined>(undefined)
  const [joined, setJoined] = useState(false)
  const joiningRef = useRef(false)
  const startedRef = useRef(false)

  useEffect(
    () =>
      watchRoom(roomId, (next) => {
        setStatus(next)
        if (next === 'started' && joiningRef.current && !startedRef.current) {
          startedRef.current = true
          onStart({ roomId, role: 'guest' })
        }
      }),
    // onStart is stable for the lifetime of this lobby.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomId],
  )

  // Join once the room is open and this phone's camera is ready.
  useEffect(() => {
    if (status !== 'waiting' || !cameraReady || joiningRef.current) return
    joiningRef.current = true
    joinRoom(roomId)
      .then(() => setJoined(true))
      .catch((err) => {
        console.error('Failed to join room', err)
        joiningRef.current = false
      })
  }, [status, cameraReady, roomId])

  const leave = () => {
    if (joined && status === 'ready') void leaveRoom(roomId)
    if (joined && status === 'started') void closeRoom(roomId)
    onExit()
  }

  let message: string
  let canLeave = true
  if (status === undefined) {
    message = 'Connecting…'
  } else if (status === null || status === 'closed') {
    message = 'This game is no longer open.'
    canLeave = false
  } else if (status === 'started' && !joined) {
    message = 'This game already started.'
    canLeave = false
  } else if (status === 'ready' && !joined) {
    message = 'This game already has 2 players.'
    canLeave = false
  } else if (!cameraReady) {
    message = 'Getting your camera ready…'
  } else if (joined) {
    message = 'Connected! Waiting for the host to start…'
  } else {
    message = 'Joining…'
  }

  return (
    <>
      <h1>2 Player Online</h1>
      <p
        className={
          joined && status === 'ready'
            ? 'camera-stage__lobby-status camera-stage__lobby-status--ready'
            : 'camera-stage__lobby-status'
        }
      >
        {message}
      </p>
      <button
        type="button"
        className="camera-stage__action-button camera-stage__secondary-button"
        onClick={leave}
      >
        {canLeave ? 'Leave' : 'Back to menu'}
      </button>
    </>
  )
}
