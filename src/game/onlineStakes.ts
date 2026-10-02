/** Online, once you're out: what your still-playing friend needs. */
export function friendStakesText(yourScore: number, friendScore: number): string {
  if (friendScore > yourScore) return 'Friend is ahead'
  const needed = yourScore - friendScore + 1
  return `Friend needs ${needed} more to win`
}
