import type { HistoryEntry } from "../types"

/**
 * What one annotation write says. Both fields are optional and the distinction
 * is load-bearing: an absent field means this write said nothing about it, so
 * whatever is already stored stands. Reading an absent field as "set it to
 * empty" is what would make every star toggle wipe the user's note.
 */
export interface HistoryAnnotationPatch {
  note?: string
  starred?: boolean
}

/**
 * Trims, then folds blank to "no note". A note of spaces is not a note, and
 * once trimmed away it has to be indistinguishable from never having written
 * one -- otherwise the row keeps its "has a note" badge with nothing behind it.
 */
export function normalizeNote(note: string): string | undefined {
  return note.trim() || undefined
}

function annotationFields(patch: HistoryAnnotationPatch): Partial<HistoryEntry> {
  const fields: Partial<HistoryEntry> = {}

  if (patch.note !== undefined) {
    fields.note = normalizeNote(patch.note)
  }

  if (patch.starred !== undefined) {
    fields.starred = patch.starred
  }

  return fields
}

/**
 * Applies an annotation to one row, by id. The id is the identity of a single
 * send; method and url are not, and deduplicating history by that pair has
 * already been ruled a defect -- two calls to the same endpoint are two rows,
 * and a note written on one of them belongs to that one.
 */
export function applyAnnotation(
  entries: HistoryEntry[],
  id: string,
  patch: HistoryAnnotationPatch,
): HistoryEntry[] {
  const fields = annotationFields(patch)

  return entries.map((entry) => (entry.id === id ? { ...entry, ...fields } : entry))
}
