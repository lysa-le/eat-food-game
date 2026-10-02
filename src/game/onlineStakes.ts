import type { PlayerRole } from './onlineRoom'

/** Online, once you're out: what your still-playing friend needs. */
export function friendStakesText(yourScore: number, friendScore: number): string {
  if (friendScore > yourScore) return 'Friend is ahead'
  const needed = yourScore - friendScore + 1
  return `Friend needs ${needed} more to win`
}

/** The host is Player 1 (as in the lobby's "Player 2 joined"). */
export const playerNumber = (role: PlayerRole): 1 | 2 =>
  role === 'host' ? 1 : 2

export interface MatchRow {
  rank: 1 | 2
  playerNumber: 1 | 2
  score: number
  isYou: boolean
}

/**
 * Online result: who won, and both players ranked by score (higher
 * first). A tie shares rank 1, listed Player 1 first.
 */
export function onlineMatchResult(
  yourRole: PlayerRole,
  you: { score: number },
  friend: { score: number },
): { headline: string; rows: MatchRow[] } {
  const friendRole: PlayerRole = yourRole === 'host' ? 'guest' : 'host'
  const yours = { playerNumber: playerNumber(yourRole), score: you.score, isYou: true }
  const theirs = { playerNumber: playerNumber(friendRole), score: friend.score, isYou: false }
  const tie = you.score === friend.score
  const [first, second] =
    you.score > friend.score || (tie && yours.playerNumber === 1)
      ? [yours, theirs]
      : [theirs, yours]
  const headline = tie
    ? "It's a tie"
    : first.isYou
      ? 'You won'
      : `Player ${first.playerNumber} won`
  return {
    headline,
    rows: [
      { rank: 1, ...first },
      { rank: tie ? 1 : 2, ...second },
    ],
  }
}
