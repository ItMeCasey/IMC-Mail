import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Category } from '@imc/core'

export interface Selection {
  accountId?: string
  folderId?: string
  /** A smart view across all accounts. */
  view?: 'needsReply' | 'waiting' | 'suspicious' | 'snoozed' | 'followUp'
  category?: Category
  /** Show messages with this label, in any folder. */
  labelId?: string
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

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ['search', q],
    queryFn: () => window.imc.invoke('messages:search', { q }),
    enabled: q.length > 0,
    placeholderData: (prev) => prev
  })

export const useViewCounts = () =>
  useQuery({ queryKey: ['views'], queryFn: () => window.imc.invoke('views:counts') })

export const useDeals = () =>
  useQuery({ queryKey: ['deals'], queryFn: () => window.imc.invoke('deals:list') })

export const useLabels = () =>
  useQuery({ queryKey: ['labels'], queryFn: () => window.imc.invoke('labels:list') })

export const useSavedSearches = () =>
  useQuery({ queryKey: ['searches'], queryFn: () => window.imc.invoke('searches:list') })

export const useMediaKit = () =>
  useQuery({ queryKey: ['mediakit'], queryFn: () => window.imc.invoke('mediaKit:get') })
