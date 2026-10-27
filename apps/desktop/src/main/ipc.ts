import { BrowserWindow, ipcMain } from 'electron'
import type { z } from 'zod'
import {
  ipcContract,
  ipcEvents,
  type IpcChannel,
  type IpcContract,
  type IpcEvent,
  type IpcEventPayload,
  type IpcOutput
} from '@imc/core'

/** Handlers receive the parsed input (defaults applied), callers send the raw input. */
type Handlers = {
  [C in IpcChannel]: (
    input: z.output<IpcContract[C]['input']>
  ) => IpcOutput<C> | Promise<IpcOutput<C>>
}

/** Registers every channel in the contract; input and output are zod-validated. */
export function registerIpc(handlers: Handlers, afterCall?: (channel: IpcChannel) => void): void {
  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    const schema = ipcContract[channel]
    const handler = handlers[channel] as (input: unknown) => unknown
    ipcMain.handle(channel, async (_event, raw) => {
      const input = schema.input.parse(raw)
      const out = schema.output.parse(await handler(input))
      afterCall?.(channel)
      return out
    })
  }
}

export function emit<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
  const data = ipcEvents[event].parse(payload)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, data)
  }
}
