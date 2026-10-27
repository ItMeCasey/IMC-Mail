import { QueryClient } from '@tanstack/react-query'

/** Shared by the main window and the settings window; each window has its own copy of the cache. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false } }
})
