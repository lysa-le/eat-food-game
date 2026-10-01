export interface HighScoreEntry {
  initials: string
  score: number
}

export const MAX_HIGH_SCORE_ENTRIES = 5

/**
 * Inserts a new entry in descending-score order, keeping only the top
 * MAX_HIGH_SCORE_ENTRIES. Uses referential equality (not score value, in
 * case of ties) so the caller can find exactly the entry it just passed
 * in — see its index in the result, or -1 if it didn't make the cut.
 */
export function insertHighScore(
  entries: HighScoreEntry[],
  entry: HighScoreEntry,
): HighScoreEntry[] {
  return [...entries, entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HIGH_SCORE_ENTRIES)
}

export function formatScore(score: number): string {
  return Math.max(0, score).toString().padStart(6, '0')
}
