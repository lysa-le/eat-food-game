import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore'
import { getDb, isGlobalLeaderboardConfigured } from './globalLeaderboard'
import { effectiveRoomStatus, type RoomStatus } from './roomStatus'

export type { RoomStatus }

/**
 * Online 2 Player rooms. The host creates a room and shares its link;
 * opening the link joins it. Each phone runs its own game — the room
 * only coordinates who's in and when to start.
 *
 *   waiting  → host created it, nobody has joined
 *   ready    → a friend joined (back to waiting if they leave)
 *   started  → host pressed Start; both phones count down and play
 *   closed   → host cancelled
 *
 * Transitions are enforced by firestore.rules.
 */
const ROOMS_COLLECTION = 'rooms'
/** Rooms are only for setting up a game; firestore.rules caps this. */
const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
/** Long and random, since the link is the only thing that grants access
 * (there's no code to type, so it never needs to be short). */
const ROOM_ID_LENGTH = 20
const ROOM_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** firestore.rules lets anyone delete a room 24h past its expiry; asking
 * for 25h leaves an hour of slack for a phone clock that runs fast. */
const CLEANUP_AFTER_EXPIRY_MS = 25 * 60 * 60 * 1000
/** Matches the list limit in firestore.rules. */
const CLEANUP_BATCH_SIZE = 10

/** Rooms live in the same Firebase project as the leaderboard. */
export function isOnlineAvailable(): boolean {
  return isGlobalLeaderboardConfigured()
}

function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_ID_LENGTH))
  return Array.from(
    bytes,
    (b) => ROOM_ID_ALPHABET[b % ROOM_ID_ALPHABET.length],
  ).join('')
}

function roomRef(roomId: string) {
  return doc(getDb(), ROOMS_COLLECTION, roomId)
}

export function roomLink(roomId: string): string {
  const url = new URL(import.meta.env.BASE_URL, window.location.origin)
  url.searchParams.set('room', roomId)
  return url.toString()
}

/** Reads (and strips) ?room= from the current URL, so a refresh or the
 * installed app's start URL doesn't try to rejoin an old room. */
export function takeRoomIdFromUrl(): string | null {
  const url = new URL(window.location.href)
  const roomId = url.searchParams.get('room')
  if (!roomId) return null
  url.searchParams.delete('room')
  window.history.replaceState(null, '', url.toString())
  return /^[a-z0-9]+$/.test(roomId) ? roomId : null
}

export async function createRoom(): Promise<string> {
  const roomId = newRoomId()
  await setDoc(roomRef(roomId), {
    status: 'waiting',
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + ROOM_LIFETIME_MS),
  })
  // Free-tier housekeeping (TTL policies need billing): each new room
  // clears out a few long-expired ones. Never blocks or fails creation.
  void cleanupExpiredRooms()
  return roomId
}

export async function cleanupExpiredRooms(): Promise<number> {
  try {
    const expired = await getDocs(
      query(
        collection(getDb(), ROOMS_COLLECTION),
        where(
          'expiresAt',
          '<',
          Timestamp.fromMillis(Date.now() - CLEANUP_AFTER_EXPIRY_MS),
        ),
        limit(CLEANUP_BATCH_SIZE),
      ),
    )
    // Firestore doesn't delete subcollections with their parent, so clear
    // each room's player docs first (the rules check the parent room).
    await Promise.all(
      expired.docs.map(async (d) => {
        await Promise.all(
          PLAYER_ROLES.map((role) => deleteDoc(playerRef(d.id, role))),
        )
        await deleteDoc(d.ref)
      }),
    )
    return expired.size
  } catch (err) {
    console.warn('Expired room cleanup skipped', err)
    return -1
  }
}

/** Who's who in a room: the host created it, the guest joined by link. */
export type PlayerRole = 'host' | 'guest'
const PLAYER_ROLES: PlayerRole[] = ['host', 'guest']

export const otherRole = (role: PlayerRole): PlayerRole =>
  role === 'host' ? 'guest' : 'host'

/** One player's live game, shown in the other phone's Friend box. */
export interface PlayerState {
  score: number
  lives: number
  level: number
  /** Out of lives — their game is over. */
  out: boolean
  /** Which round this is from (Play Again starts round 2, 3…), so a
   * finished round's "out" can't end the next one. */
  round: number
}

/** Each player writes only their own doc, at rooms/{id}/players/{role}
 * (validated by firestore.rules), so the two phones never contend for
 * the same document. */
function playerRef(roomId: string, role: PlayerRole) {
  return doc(getDb(), ROOMS_COLLECTION, roomId, 'players', role)
}

export function publishPlayerState(
  roomId: string,
  role: PlayerRole,
  state: PlayerState,
): Promise<void> {
  return setDoc(playerRef(roomId, role), {
    score: Math.max(0, Math.floor(state.score)),
    lives: state.lives,
    level: state.level,
    out: state.out,
    round: state.round,
    updatedAt: serverTimestamp(),
  })
}

/** Calls back with the player's latest state, or null before their first
 * update arrives. */
export function watchPlayerState(
  roomId: string,
  role: PlayerRole,
  onChange: (state: PlayerState | null) => void,
): Unsubscribe {
  return onSnapshot(
    playerRef(roomId, role),
    (snapshot) => {
      const data = snapshot.data()
      onChange(
        data
          ? {
              score: Number(data.score) || 0,
              lives: Number(data.lives) || 0,
              level: Number(data.level) || 1,
              out: data.out === true,
              round: Number(data.round) || 1,
            }
          : null,
      )
    },
    (err) => {
      console.error('Player listener failed', err)
    },
  )
}

function setStatus(roomId: string, status: RoomStatus): Promise<void> {
  return updateDoc(roomRef(roomId), { status })
}

export const joinRoom = (roomId: string) => setStatus(roomId, 'ready')
export const leaveRoom = (roomId: string) => setStatus(roomId, 'waiting')
export const closeRoom = (roomId: string) => setStatus(roomId, 'closed')
export const startRoom = (roomId: string) =>
  updateDoc(roomRef(roomId), {
    status: 'started',
    startedAt: serverTimestamp(),
    round: 1,
  })

/** Play Again: marks this player as ready for another round. When both
 * are, the host starts it (startNextRound). */
export const requestPlayAgain = (roomId: string, role: PlayerRole) =>
  updateDoc(roomRef(roomId), { [`${role}Again`]: true })

export const startNextRound = (roomId: string, nextRound: number) =>
  updateDoc(roomRef(roomId), {
    round: nextRound,
    hostAgain: false,
    guestAgain: false,
    startedAt: serverTimestamp(),
  })

/** What a phone in a running online game needs to know about its room. */
export interface RoomState {
  status: RoomStatus | null
  round: number
  hostAgain: boolean
  guestAgain: boolean
}

/** Like watchRoom (server-confirmed only), plus the round and Play
 * Again taps. */
export function watchRoomState(
  roomId: string,
  onChange: (state: RoomState) => void,
): Unsubscribe {
  return onSnapshot(
    roomRef(roomId),
    CONFIRMED_ONLY,
    (snapshot) => {
      if (snapshot.metadata.hasPendingWrites) return
      const data = snapshot.data()
      const expiresAt = data?.expiresAt
      onChange({
        status: effectiveRoomStatus(
          data?.status,
          expiresAt instanceof Timestamp ? expiresAt.toMillis() : null,
          Date.now(),
        ),
        round: Number(data?.round) || 1,
        hostAgain: data?.hostAgain === true,
        guestAgain: data?.guestAgain === true,
      })
    },
    (err) => {
      console.error('Room listener failed', err)
    },
  )
}

/**
 * Firestore shows this phone's own writes instantly, before the server
 * accepts them. A rejected write (e.g. an older app version against newer
 * rules) would briefly look like "started" and then revert — enough for
 * the host to count down into a game the guest never sees. Room listeners
 * therefore ignore snapshots with unconfirmed local writes.
 */
const CONFIRMED_ONLY = { includeMetadataChanges: true } as const

/** Calls back with the room's status on every server-confirmed change,
 * or null if the room doesn't exist or can't be read. Expired rooms
 * report 'closed'. */
export function watchRoom(
  roomId: string,
  onChange: (status: RoomStatus | null) => void,
): Unsubscribe {
  return onSnapshot(
    roomRef(roomId),
    CONFIRMED_ONLY,
    (snapshot) => {
      if (snapshot.metadata.hasPendingWrites) return
      const data = snapshot.data()
      const expiresAt = data?.expiresAt
      onChange(
        effectiveRoomStatus(
          data?.status,
          expiresAt instanceof Timestamp ? expiresAt.toMillis() : null,
          Date.now(),
        ),
      )
    },
    (err) => {
      console.error('Room listener failed', err)
      onChange(null)
    },
  )
}
