import type { ImcApi } from './index'

declare global {
  interface Window {
    imc: ImcApi
  }
}
