import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Test double; never use outside tests. */
export function memorySecrets(): SecretStore {
  const m = new Map<string, string>()
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k)
  }
}

/**
 * Secrets live in one JSON file whose values are encrypted with the OS keystore
 * (DPAPI on Windows, Keychain on macOS) through Electron's safeStorage.
 */
export async function safeStorageSecrets(file: string): Promise<SecretStore> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('OS encryption is not available, refusing to store credentials')
  }

  const read = (): Record<string, string> =>
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {}

  const write = (data: Record<string, string>): void => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    async get(key) {
      const enc = read()[key]
      if (enc === undefined) return undefined
      return (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result
    },
    async set(key, value) {
      const enc = (await safeStorage.encryptStringAsync(value)).toString('base64')
      write({ ...read(), [key]: enc })
    },
    async delete(key) {
      const data = read()
      delete data[key]
      write(data)
    }
  }
}
