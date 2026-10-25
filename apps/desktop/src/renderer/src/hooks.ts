import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

export interface Selection {
  accountId?: string
  folderId?: string
}

export const useAccounts = () =>
  useQuery({ queryKey: ['accounts'], queryFn: () => window.imc.invoke('accounts:list') })

export const useFolders = () =>
  useQuery({ queryKey: ['folders'], queryFn: () => window.imc.invoke('folders:list') })

export const useMessages = (sel: Selection) =>
  useQuery({
    queryKey: ['messages', sel],
    queryFn: () => window.imc.invoke('messages:list', { ...sel, limit: 200, offset: 0 })
  })

/** Refetches everything when the main process reports cache changes (coalesced). */
export function useSyncInvalidation(): void {
  const qc = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const offOutbox = window.imc.on('outbox:changed', () => void qc.invalidateQueries({ queryKey: ['outbox'] }))
    const off = window.imc.on('sync:changed', () => {
      clearTimeout(timer)
      timer = setTimeout(() => void qc.invalidateQueries(), 250)
    })
    return () => {
      clearTimeout(timer)
      off()
      offOutbox()
    }
  }, [qc])
}

export const useThread = (id: string | null) =>
  useQuery({
    queryKey: ['thread', id],
    queryFn: () => window.imc.invoke('messages:open', { id: id! }),
    enabled: id !== null,
    retry: false
  })

export const useOutbox = () =>
  useQuery({ queryKey: ['outbox'], queryFn: () => window.imc.invoke('outbox:list') })

export const useDrafts = () =>
  useQuery({ queryKey: ['drafts'], queryFn: () => window.imc.invoke('compose:drafts') })
