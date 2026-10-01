/** waiting → ready → started, or closed. See onlineRoom.ts. */
export type RoomStatus = 'waiting' | 'ready' | 'started' | 'closed'

/**
 * The status a phone should act on. A room past its expiry is treated as
 * closed (firestore.rules also refuses to join or start it), so an old
 * link to a room whose host just closed the app shows "no longer open"
 * instead of waiting for a host who's gone. A game that already started
 * keeps its status.
 */
export function effectiveRoomStatus(
  status: unknown,
  expiresAtMs: number | null,
  nowMs: number,
): RoomStatus | null {
  if (
    status !== 'waiting' &&
    status !== 'ready' &&
    status !== 'started' &&
    status !== 'closed'
  ) {
    return null
  }
  if (status !== 'started' && expiresAtMs !== null && expiresAtMs <= nowMs) {
    return 'closed'
  }
  return status
}
