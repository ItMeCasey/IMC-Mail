import { contextBridge, ipcRenderer } from 'electron'
import {
  ipcChannels,
  ipcEventNames,
  type IpcChannel,
  type IpcEvent,
  type IpcEventPayload,
  type IpcInput,
  type IpcOutput
} from '@imc/core'

const channels = new Set<string>(ipcChannels)
const events = new Set<string>(ipcEventNames)

const api = {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>> {
    if (!channels.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`))
    return ipcRenderer.invoke(channel, input)
  },
  /** Subscribes to a main-process push; returns an unsubscribe function. */
  on<E extends IpcEvent>(event: E, cb: (payload: IpcEventPayload<E>) => void): () => void {
    if (!events.has(event)) throw new Error(`Unknown event: ${event}`)
    const listener = (_e: unknown, payload: IpcEventPayload<E>) => cb(payload)
    ipcRenderer.on(event, listener)
    return () => void ipcRenderer.removeListener(event, listener)
  }
}

contextBridge.exposeInMainWorld('imc', api)

export type ImcApi = typeof api
