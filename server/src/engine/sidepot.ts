export interface SidePot {
  amount: number
  eligiblePlayerIds: string[]
}

export function buildSidePots(contributions: Record<string, number>): SidePot[] {
  const entries = Object.entries(contributions).sort((a, b) => a[1] - b[1])
  const pots: SidePot[] = []
  let previousLevel = 0

  for (let i = 0; i < entries.length; i++) {
    const [, level] = entries[i]
    if (level === previousLevel) continue

    pots.push({
      amount: (level - previousLevel) * (entries.length - i),
      eligiblePlayerIds: entries.filter(([, v]) => v >= level).map(([id]) => id),
    })

    previousLevel = level
  }

  return pots
}
