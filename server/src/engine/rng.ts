const QRNG_URL = 'https://qrng.anu.edu.au/API/jsonI.php'

interface QrngResponse {
  type: string
  length: number
  data: number[]
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
    return json.data
  } finally {
    clearTimeout(timeout)
  }
}
