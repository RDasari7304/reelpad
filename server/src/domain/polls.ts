/** Winning option of a poll: most votes; a tie goes to the option listed first; no votes = no winner. */
export function pollWinner(optionCount: number, votes: Array<{ option: number; n: number }>): number | null {
  let best: number | null = null;
  let bestN = 0;
  for (let i = 0; i < optionCount; i++) {
    const n = votes.filter((v) => v.option === i).reduce((s, v) => s + v.n, 0);
    if (n > bestN) {
      best = i;
      bestN = n;
    }
  }
  return best;
}
