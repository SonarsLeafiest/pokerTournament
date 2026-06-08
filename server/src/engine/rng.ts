const QRNG_URL = 'https://qrng.anu.edu.au/API/jsonI.php'

interface QrngResponse {
  type: string
  length: number
  data: unknown[]
  success: boolean
}

export async function fetchQuantumSeeds(count = 8): Promise<number[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 500)

  try {
    const res = await fetch(`${QRNG_URL}?length=${count}&type=uint16`, {
      signal: controller.signal,
    })
    const json = (await res.json()) as QrngResponse
    if (!json.success) throw new Error('QRNG API returned success=false')
    const data: unknown[] = json.data
    if (!Array.isArray(data) || data.length !== count || !data.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 65535)) {
      throw new Error('QRNG returned invalid data')
    }
    console.log(`[rng] quantum seed from ANU QRNG (${count} values)`)
    return data as number[]
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Returns seeds for shuffleDeck that always include local CSPRNG entropy.
 * Even if the QRNG response is intercepted or forged, the 256 bits from
 * crypto.getRandomValues are hashed in — making the deck unpredictable
 * to anyone who doesn't control this process.
 */
export async function fetchMixedSeeds(count = 8): Promise<number[]> {
  const quantum = await fetchQuantumSeeds(count).catch((err: unknown) => {
    console.warn('[rng] QRNG unavailable — local entropy only:', (err as Error).message ?? String(err))
    return [] as number[]
  })

  const local = Array.from(crypto.getRandomValues(new Uint32Array(count)))

  if (quantum.length > 0) {
    console.log(`[rng] mixed seed: ANU QRNG (${quantum.length} × uint16) + local CSPRNG (${count} × uint32)`)
  }

  // Concatenate so shuffleDeck's SHA-256 PRNG hashes both sources together.
  // An attacker controlling the QRNG response still cannot know the local contribution.
  return [...quantum, ...local]
}
