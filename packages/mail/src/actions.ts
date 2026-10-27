import { ImapError, type Folder, type ImapClient, type SpecialUse } from './imap'

export type MessageAction = 'archive' | 'trash' | 'junk' | 'delete' | 'markRead' | 'markUnread' | 'star' | 'unstar'

/** The folder with this purpose, if the account has one. Gmail's "All Mail" counts as the archive. */
export function folderFor(folders: Folder[], use: SpecialUse): Folder | null {
  const usable = folders.filter((f) => f.selectable)
  if (use === 'archive') return usable.find((f) => f.specialUse === 'archive') ?? usable.find((f) => f.specialUse === 'all') ?? null
  return usable.find((f) => f.specialUse === use) ?? null
}

type Reader = Pick<ImapClient, 'select' | 'move' | 'deleteForever' | 'setFlags'>

const WHERE: Record<'archive' | 'trash' | 'junk', string> = { archive: 'an archive folder', trash: 'a Trash folder', junk: 'a Spam folder' }

/**
 * Does something to messages in a folder: files them away, trashes them, deletes them for good (from Trash or Spam
 * only), or changes their read and starred marks. Returns whether they left the folder (so a list can drop them).
 */
export async function applyAction(client: Reader, folders: Folder[], from: string, uids: number[], action: MessageAction): Promise<{ left: boolean }> {
  if (uids.length === 0) return { left: false }
  const here = folders.find((f) => f.path === from)
  await client.select(from, false)
  switch (action) {
    case 'markRead':
      await client.setFlags(uids, { add: ['\\Seen'] })
      return { left: false }
    case 'markUnread':
      await client.setFlags(uids, { remove: ['\\Seen'] })
      return { left: false }
    case 'star':
      await client.setFlags(uids, { add: ['\\Flagged'] })
      return { left: false }
    case 'unstar':
      await client.setFlags(uids, { remove: ['\\Flagged'] })
      return { left: false }
    case 'delete':
      // Mail already in Trash or Spam goes for good; anything else goes to Trash first.
      if (here?.specialUse === 'trash' || here?.specialUse === 'junk') {
        await client.deleteForever(uids)
        return { left: true }
      }
      return applyAction(client, folders, from, uids, 'trash')
    case 'archive':
    case 'trash':
    case 'junk': {
      const dest = folderFor(folders, action)
      if (!dest) throw new ImapError(`This account does not have ${WHERE[action]}`, 'no')
      if (dest.path === from) return { left: false }
      await client.move(uids, dest.path)
      return { left: true }
    }
  }
}
