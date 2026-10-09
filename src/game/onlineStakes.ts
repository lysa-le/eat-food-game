import type { PlayerRole } from './onlineRoom'

/** Online, once you're out: what the still-playing player needs. */
export function friendStakesText(
  yourScore: number,
  friendScore: number,
  friendNumber: 1 | 2,
): string {
  if (friendScore > yourScore) return `Player ${friendNumber} is ahead`
  const needed = yourScore - friendScore + 1
  return `Player ${friendNumber} needs ${needed} more to win`
}

/** The host is Player 1 (as in the lobby's "Player 2 joined"). */
export const playerNumber = (role: PlayerRole): 1 | 2 =>
  role === 'host' ? 1 : 2

export interface MatchRow {
  rank: 1 | 2
  playerNumber: 1 | 2
  score: number
  isYou: boolean
  /** Quit before finishing (shown as "Quit" instead of a score). */
  quit: boolean
}

/**
 * Online result: who won, and both players ranked by score (higher
 * first). A tie shares rank 1, listed Player 1 first. If the other player
 * quit before finishing, you win whatever the scores.
 */
export function onlineMatchResult(
  yourRole: PlayerRole,
  you: { score: number },
  friend: { score: number },
  friendQuit = false,
): { headline: string; rows: MatchRow[] } {
  const friendRole: PlayerRole = yourRole === 'host' ? 'guest' : 'host'
  const yours = { playerNumber: playerNumber(yourRole), score: you.score, isYou: true, quit: false }
  const theirs = { playerNumber: playerNumber(friendRole), score: friend.score, isYou: false, quit: friendQuit }
  if (friendQuit) {
    return {
      headline: 'You Win!',
      rows: [
        { rank: 1, ...yours },
        { rank: 2, ...theirs },
      ],
    }
  }
  const tie = you.score === friend.score
  const [first, second] =
    you.score > friend.score || (tie && yours.playerNumber === 1)
      ? [yours, theirs]
      : [theirs, yours]
  const headline = tie
    ? "It's a Tie!"
    : first.isYou
      ? 'You Win!'
      : `Player ${first.playerNumber} Wins!`
  return {
    headline,
    rows: [
      { rank: 1, ...first },
      { rank: tie ? 1 : 2, ...second },
    ],
  }
}
