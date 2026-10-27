import Holidays from 'date-holidays'

export interface Holiday {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  name: string
}

export interface HolidayCountry {
  code: string
  name: string
}

/** Days off that the country marks on its calendar; school terms and optional observances are left out. */
const KINDS = new Set(['public', 'bank'])

/** Every country the holiday data covers, sorted by name. */
export function holidayCountries(): HolidayCountry[] {
  return Object.entries(new Holidays().getCountries('en'))
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The country's public holidays that fall on days from `from` up to (not including) `to`, as epoch ms. */
export function holidaysBetween(country: string, from: number, to: number): Holiday[] {
  const hd = new Holidays(country)
  const first = new Date(from)
  const last = new Date(to - 1)
  const seen = new Set<string>()
  const out: Holiday[] = []
  for (let year = first.getFullYear(); year <= last.getFullYear(); year++) {
    for (const h of hd.getHolidays(year, 'en')) {
      if (!KINDS.has(h.type)) continue
      const date = h.date.slice(0, 10)
      const at = new Date(`${date}T00:00:00`).getTime()
      const key = `${date}|${h.name}`
      if (at < from || at >= to || seen.has(key)) continue
      seen.add(key)
      out.push({ date, name: h.name })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** A starting country from the system language (en-GB gives GB), or the US when there is none. */
export function defaultHolidayCountry(locale: string): string {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase()
  return region && new Holidays().getCountries()[region] ? region : 'US'
}
