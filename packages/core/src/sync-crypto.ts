// The cryptography of device sync, on the Web Crypto API that Node, Electron and React Native all provide.
// The server holds only ciphertext. Records are sealed with AES-256-GCM under a key that exists on your
// own devices; the record's id, type, clock and deleted flag are authenticated data, so the server cannot
// hand one record's payload back as another's, or an old version as the current one.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Base64url without padding, written out so it does not depend on `btoa` or `Buffer`. */
export function toB64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!
  }
  return out
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('Not valid base64url')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let acc = 0
  let o = 0
  for (const ch of text) {
    acc = (acc << 6) | ALPHABET.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 255
    }
  }
  return out
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const subtle = () => globalThis.crypto.subtle
const random = (n: number): Uint8Array<ArrayBuffer> => globalThis.crypto.getRandomValues(new Uint8Array(n))

/** A new random 256-bit key for a sync group. It is shown in the pairing code and kept only on your devices. */
export const newDataKey = (): string => toB64(random(32))
export const newGroupId = (): string => toB64(random(16))
/** A short id for one device, safe to put inside a clock stamp. */
export const newDeviceId = (): string => toB64(random(9)).replace(/-/g, 'a')

const KEY = /^[A-Za-z0-9_-]{43}$/
export const isDataKey = (s: string): boolean => KEY.test(s)

async function derive(master: string, info: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await subtle().importKey('raw', fromB64(master), 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, base, bytes * 8)
  return new Uint8Array(bits)
}

const sha256 = async (data: string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await subtle().digest('SHA-256', enc.encode(data)))

/** The proof a new device shows to join a group. Derived from the key one way, so the server never learns the key. */
export async function joinToken(dataKey: string): Promise<string> {
  return toB64(await derive(dataKey, 'imc-sync join v1', 32))
}

/** What the server stores to check a join token against. */
export async function joinHash(token: string): Promise<string> {
  return toB64(await sha256(token))
}

export interface Sealed {
  id: string
  type: string
  hlc: string
  deleted: boolean
}

const aad = (e: Sealed) => enc.encode(`imc-sync1|${e.id}|${e.type}|${e.hlc}|${e.deleted ? 1 : 0}`)

async function aesKey(dataKey: string): Promise<CryptoKey> {
  const raw = await derive(dataKey, 'imc-sync encrypt v1', 32)
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Seals a record's contents. Returns base64url of a fresh random nonce followed by the ciphertext. */
export async function sealPayload(dataKey: string, envelope: Sealed, contents: unknown): Promise<string> {
  const iv = random(12)
  const body = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(envelope) }, await aesKey(dataKey), enc.encode(JSON.stringify(contents)))
  const out = new Uint8Array(12 + body.byteLength)
  out.set(iv)
  out.set(new Uint8Array(body), 12)
  return toB64(out)
}

/** Opens a sealed payload. Throws if the key is wrong or anything in the envelope or payload was changed. */
export async function openPayload(dataKey: string, envelope: Sealed, payload: string): Promise<unknown> {
  const bytes = fromB64(payload)
  if (bytes.length < 12 + 16) throw new Error('The payload is too short')
  const body = await subtle().decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad(envelope) },
    await aesKey(dataKey),
    bytes.slice(12)
  )
  return JSON.parse(dec.decode(body)) as unknown
}

// ---- device keys: every request to the server is signed ------------------------------------------------

export interface DeviceKeys {
  /** The public half, 65 raw bytes, base64url. Sent to the server. */
  publicKey: string
  /** The private half, PKCS#8, base64url. Never leaves the device. */
  privateKey: string
}

export async function newDeviceKeys(): Promise<DeviceKeys> {
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    publicKey: toB64(new Uint8Array(await subtle().exportKey('raw', pair.publicKey))),
    privateKey: toB64(new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey)))
  }
}

export async function signText(privateKey: string, text: string): Promise<string> {
  const key = await subtle().importKey('pkcs8', fromB64(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return toB64(new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(text))))
}

export async function verifyText(publicKey: string, text: string, signature: string): Promise<boolean> {
  try {
    const key = await subtle().importKey('raw', fromB64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(signature), enc.encode(text))
  } catch {
    return false
  }
}

export const hashBody = async (body: string): Promise<string> => toB64(await sha256(body))
