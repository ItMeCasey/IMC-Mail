import TcpSocket from 'react-native-tcp-socket'
import type { Connect, MailSocket } from '@imc/mail'

const enc = new TextEncoder()

/**
 * Opens a mail connection on the phone's TCP library. TLS checks the certificate against the system's
 * trusted authorities and (through the patch in patches/react-native-tcp-socket.patch) that it belongs
 * to the host, so a certificate for some other site is refused.
 */
export const tcpConnect: Connect = (host, port, tls) =>
  new Promise<MailSocket>((resolve, reject) => {
    // Anything that arrives before the mail code starts listening is kept for it.
    let onData: ((c: Uint8Array) => void) | null = null
    const early: Uint8Array[] = []
    let onClose: ((e?: Error) => void) | null = null
    let ended: { error?: Error } | null = null
    let settled = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let socket: any

    const finish = (error?: Error) => {
      if (ended) return
      ended = error ? { error } : {}
      onClose?.(error)
    }
    const data = (d: unknown) => {
      const bytes = typeof d === 'string' ? enc.encode(d) : new Uint8Array(d as ArrayLike<number>)
      if (onData) onData(bytes)
      else early.push(bytes)
    }
    const failed = (e: Error) => {
      if (!settled) {
        settled = true
        reject(e)
      } else finish(e)
    }
    const ready = () => {
      if (settled) return
      settled = true
      resolve({
        write: (bytes) => socket.write(bytes),
        onData: (cb) => {
          onData = cb
          for (const c of early.splice(0)) cb(c)
        },
        onClose: (cb) => {
          onClose = cb
          if (ended) cb(ended.error)
        },
        startTls: async () => {
          // Leave the plain connection's listeners behind, then wrap it in TLS. Reading the peer
          // certificate waits until the handshake is done (and throws if it failed).
          socket.off('data', data)
          const secure = new TcpSocket.TLSSocket(socket, {})
          secure.on('data', data)
          secure.on('error', (e: Error) => failed(e))
          secure.on('close', () => finish())
          socket = secure
          await secure.getPeerCertificate()
        },
        close: () => {
          try {
            socket.destroy()
          } catch {
            // already closed
          }
        }
      })
    }

    const opts = { host, port, connectTimeout: 20_000 }
    socket = tls ? TcpSocket.connectTLS(opts, ready) : TcpSocket.createConnection(opts, ready)
    socket.on('data', data)
    socket.on('error', (e: Error) => failed(e))
    socket.on('close', () => finish())
  })
