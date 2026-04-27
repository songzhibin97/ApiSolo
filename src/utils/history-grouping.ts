import type { HistoryEntry, HistoryGroup } from "../types"

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

export function groupByPrefix(entries: HistoryEntry[], depth: number): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()

  for (const entry of entries) {
    const parsed = parseHistoryUrl(entry.url)
    const prefix = parsed.segments.length > 0 ? `/${parsed.segments.slice(0, depth).join("/")}` : "/"
    const label = parsed.host ? `${parsed.host} ${prefix}` : prefix
    const key = parsed.host ? `${parsed.host}${prefix}` : `${prefix}:${entry.url}`
    const group = groups.get(key) ?? {
      label,
      entries: [],
      count: 0,
    }

    group.entries.push(entry)
    group.count = group.entries.length
    groups.set(key, group)
  }

  return finalizeGroups(groups)
}

export function groupByMethod(entries: HistoryEntry[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()

  for (const entry of entries) {
    const label = entry.method.toUpperCase() || "UNKNOWN"
    const group = groups.get(label) ?? {
      label,
      entries: [],
      count: 0,
    }

    group.entries.push(entry)
    group.count = group.entries.length
    groups.set(label, group)
  }

  return [...groups.values()]
    .map(sortGroupEntries)
    .sort((left, right) => {
      const leftIndex = METHOD_ORDER.indexOf(left.label)
      const rightIndex = METHOD_ORDER.indexOf(right.label)
      const methodOrder = normalizeMethodIndex(leftIndex) - normalizeMethodIndex(rightIndex)
      if (methodOrder !== 0) {
        return methodOrder
      }

      return latestTimestamp(right) - latestTimestamp(left)
    })
}

export function groupByTime(entries: HistoryEntry[]): HistoryGroup[] {
  const now = new Date()
  const startToday = startOfDay(now)
  const startYesterday = new Date(startToday)
  startYesterday.setDate(startYesterday.getDate() - 1)
  const startWeek = new Date(startToday)
  startWeek.setDate(startWeek.getDate() - ((startWeek.getDay() + 6) % 7))
  const startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1)

  const buckets: Array<{ label: HistoryGroup["label"]; entries: HistoryEntry[] }> = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "This Week", entries: [] },
    { label: "This Month", entries: [] },
    { label: "Older", entries: [] },
  ]

  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp)

    if (timestamp >= startToday) {
      buckets[0].entries.push(entry)
    } else if (timestamp >= startYesterday) {
      buckets[1].entries.push(entry)
    } else if (timestamp >= startWeek) {
      buckets[2].entries.push(entry)
    } else if (timestamp >= startMonth) {
      buckets[3].entries.push(entry)
    } else {
      buckets[4].entries.push(entry)
    }
  }

  return buckets
    .filter((bucket) => bucket.entries.length > 0)
    .map((bucket) => ({
      label: bucket.label,
      entries: sortEntries(bucket.entries),
      count: bucket.entries.length,
    }))
}

export function filterEntries(entries: HistoryEntry[], query: string): HistoryEntry[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return entries
  }
  return entries.filter((entry) => entry.url.toLowerCase().includes(trimmed))
}

export function sortEntries(entries: HistoryEntry[]) {
  return [...entries].sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

export function parseHistoryUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return {
      host: url.host,
      segments: url.pathname.split("/").filter(Boolean),
    }
  } catch {
    return {
      host: "",
      segments: rawUrl.split("?")[0].split("/").filter(Boolean),
    }
  }
}

function finalizeGroups(groups: Map<string, HistoryGroup>) {
  return [...groups.values()]
    .map(sortGroupEntries)
    .sort((left, right) => latestTimestamp(right) - latestTimestamp(left))
}

function sortGroupEntries(group: HistoryGroup): HistoryGroup {
  return {
    ...group,
    entries: sortEntries(group.entries),
    count: group.entries.length,
  }
}

function latestTimestamp(group: HistoryGroup) {
  const timestamp = group.entries[0]?.timestamp
  return timestamp ? Date.parse(timestamp) || 0 : 0
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function normalizeMethodIndex(value: number) {
  return value === -1 ? Number.MAX_SAFE_INTEGER : value
}
