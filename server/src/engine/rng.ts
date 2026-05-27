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
