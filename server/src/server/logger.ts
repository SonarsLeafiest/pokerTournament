export type LogLevel = 'log' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  message: string
  ts: number
}

const MAX_ENTRIES = 500

class ServerLogBuffer {
  private entries: LogEntry[] = []
  private subscribers = new Set<(entry: LogEntry) => void>()

  append(entry: LogEntry): void {
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    for (const sub of this.subscribers) sub(entry)
  }

  getAll(): readonly LogEntry[] {
    return this.entries
  }

  /** Subscribe to live entries. Returns an unsubscribe function. */
  subscribe(fn: (entry: LogEntry) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }
}

export const serverLogBuffer = new ServerLogBuffer()

/** Intercept console.log/warn/error so all server output is also buffered. */
export function patchConsole(): void {
  const origLog   = console.log.bind(console)
  const origWarn  = console.warn.bind(console)
  const origError = console.error.bind(console)

  const wrap = (level: LogLevel, orig: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      orig(...args)
      serverLogBuffer.append({
        level,
        message: args.map(a => (typeof a === 'string' ? a : String(a))).join(' '),
        ts: Date.now(),
      })
    }

  console.log   = wrap('log',   origLog)
  console.warn  = wrap('warn',  origWarn)
  console.error = wrap('error', origError)
}
