/**
 * What the mail code needs from a network connection. The phone supplies one built on its TCP library,
 * tests supply one that talks to a fake server, and nothing here depends on either.
 */
export interface MailSocket {
  write(data: Uint8Array): void
  /** Called with each piece of data that arrives. Set once. Data that arrived before it was set must be delivered to it then. */
  onData(cb: (chunk: Uint8Array) => void): void
  /** Called once when the connection ends, with the reason if it failed. */
  onClose(cb: (error?: Error) => void): void
  /** Upgrades the open connection to TLS (for STARTTLS). */
  startTls(): Promise<void>
  close(): void
}

/** Opens a connection. `tls` means TLS from the first byte (port 993 style). */
export type Connect = (host: string, port: number, tls: boolean) => Promise<MailSocket>

export type Security = 'tls' | 'starttls' | 'none'
