import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import AddAccount from './AddAccount'
import MessageList from './MessageList'
import ReadingPane from './ReadingPane'
import Sidebar from './Sidebar'
import {
  useAccounts,
  useFolders,
  useMessages,
  useSyncInvalidation,
  useThread,
  type Selection
} from './hooks'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false } }
})

function Shell() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const folders = useFolders()
  const [selection, setSelection] = useState<Selection>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const messages = useMessages(selection)
  const thread = useThread(openId)
  useSyncInvalidation()

  const folder = folders.data?.find((f) => f.id === selection.folderId)
  const account = accounts.data?.find((a) => a.id === selection.accountId)
  const title = folder
    ? `${account?.displayName || account?.email || ''} · ${folder.name}`
    : 'All inboxes'

  // Opening a message marks it read, once per message.
  const markedRead = useRef(new Set<string>())
  useEffect(() => {
    const sel = thread.data?.messages.find((m) => m.id === thread.data?.selectedId)
    if (!sel?.unread || markedRead.current.has(sel.id)) return
    markedRead.current.add(sel.id)
    void window.imc
      .invoke('messages:setFlags', { id: sel.id, seen: true })
      .then(() => qc.invalidateQueries())
      .catch(() => markedRead.current.delete(sel.id)) // offline: try again on the next open
  }, [thread.data, qc])

  // Escape closes the reading pane, unless a dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openId && !adding) setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, adding])

  const select = (s: Selection) => {
    setSelection(s)
    setOpenId(null)
  }

  const remove = async (id: string) => {
    if (selection.accountId === id) select({})
    await window.imc.invoke('accounts:remove', { id })
    await qc.invalidateQueries()
  }

  return (
    <div className="flex h-full">
      <Sidebar
        accounts={accounts.data ?? []}
        folders={folders.data ?? []}
        selection={selection}
        onSelect={select}
        onAdd={() => setAdding(true)}
        onRemove={remove}
        onResync={(id) => void window.imc.invoke('accounts:resync', { id })}
      />
      <MessageList
        title={title}
        messages={messages.data ?? []}
        accounts={accounts.data ?? []}
        loading={messages.isPending || accounts.isPending}
        selectedId={openId}
        onSelect={setOpenId}
        onAdd={() => setAdding(true)}
      />
      {openId && (
        <ReadingPane
          key={openId}
          thread={thread.data}
          loading={thread.isPending}
          error={thread.error}
          onClose={() => setOpenId(null)}
        />
      )}
      {adding && <AddAccount onClose={() => setAdding(false)} />}
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  )
}
