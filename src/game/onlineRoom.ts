import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { getDb, isGlobalLeaderboardConfigured } from './globalLeaderboard'

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
export type RoomStatus = 'waiting' | 'ready' | 'started' | 'closed'

const ROOMS_COLLECTION = 'rooms'
/** Rooms are only for setting up a game; firestore.rules caps this. */
const ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
/** Long and random, since the link is the only thing that grants access
 * (there's no code to type, so it never needs to be short). */
const ROOM_ID_LENGTH = 20
const ROOM_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

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
  return roomId
}

function setStatus(roomId: string, status: RoomStatus): Promise<void> {
  return updateDoc(roomRef(roomId), { status })
}

export const joinRoom = (roomId: string) => setStatus(roomId, 'ready')
export const leaveRoom = (roomId: string) => setStatus(roomId, 'waiting')
export const closeRoom = (roomId: string) => setStatus(roomId, 'closed')
export const startRoom = (roomId: string) =>
  updateDoc(roomRef(roomId), { status: 'started', startedAt: serverTimestamp() })

/** Calls back with the room's status on every change, or null if the
 * room doesn't exist or can't be read. */
export function watchRoom(
  roomId: string,
  onChange: (status: RoomStatus | null) => void,
): Unsubscribe {
  return onSnapshot(
    roomRef(roomId),
    (snapshot) => {
      const status = snapshot.data()?.status
      onChange(typeof status === 'string' ? (status as RoomStatus) : null)
    },
    (err) => {
      console.error('Room listener failed', err)
      onChange(null)
    },
  )
}
