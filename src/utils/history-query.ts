import type { KeyValuePair } from "../types"
import { REDACTION_SENTINEL } from "./redaction"
import { deriveParamsFromUrl } from "./url-params"

/**
 * The query rows a history entry describes. It records its query twice and
 * neither copy is a superset of the other, so this reads both rather than
 * picking one:
 *
 *   - `requestParams` holds the rows that actually went on the wire — the send
 *     path strips the url's own query and sends this list — but it did not
 *     exist for early entries.
 *   - The url holds the query as the tab was displaying it, which is where an
 *     early entry's parameters live, and where a parameter can appear that the
 *     params copy never had.
 *
 * Taking one and discarding the other was the defect. Discarding the url lost
 * a url-only parameter outright: it is not merely hidden, because the rows are
 * what gets sent, so a parameter missing from this list is a parameter that
 * never goes out — and since `openHistoryEntry` goes on to clear the
 * placeholder out of the url, it disappeared without leaving a mark on screen
 * either.
 *
 * The overlap is resolved per key: rows the params copy already has are kept as
 * they are, and the url contributes only keys it does not have. Params win
 * because params are what gets sent, so a real value there is a real value on
 * the wire whatever the url's stale copy of that key still spells.
 *
 * The url is read for one more thing: which keys this entry blanked. The two
 * copies do not spell that out the same way — the url redactor stamps a
 * placeholder on any sensitive key, while the pair redactor leaves an already
 * empty value alone — so a row can arrive blank here with only the url saying
 * it was blanked. Marked per key rather than per row, for the reason set out
 * above `syncParamsFromUrl`: two identical blank parameters hold no fact saying
 * which is which. And only for keys the params copy does not itself report as
 * blanked, so a key that already names its own blanked rows is not counted a
 * second time through the url.
 *
 * This lives in its own module because it is the *one* answer to the question,
 * not one of two. Both save entry points reach it — the panel through the rows
 * this builds for the tab, the history row through `queryFields` in
 * `pending-refill.ts` — and when the two had a rule each they disagreed about
 * the same row: a key the url still spelled `[redacted]` while the params copy
 * held the value already typed back in was listed as outstanding by the history
 * row and as done by the panel. Adding a case to one of two rules is what put
 * that disagreement there; a second rule is not to be written here again.
 */
export function historyQueryRows(stored: KeyValuePair[], rawUrl: string): KeyValuePair[] {
  const fromUrl = deriveParamsFromUrl(rawUrl)
  const isBlanked = (item: KeyValuePair) => item.value.trim() === REDACTION_SENTINEL

  const storedKeys = new Set(stored.map((item) => item.key))
  const storedBlanked = new Set(stored.filter(isBlanked).map((item) => item.key))
  const urlBlanked = new Set(
    fromUrl
      .filter((item) => isBlanked(item) && !storedBlanked.has(item.key))
      .map((item) => item.key),
  )

  return [...stored, ...fromUrl.filter((item) => !storedKeys.has(item.key))].map((item) =>
    // `value === ""` is what keeps the two entry points agreeing on a key whose
    // copies disagree: the url still holding a placeholder for a key the params
    // copy holds a real value for says only that the url is stale, and marking
    // the filled row would gate a request the user has already completed. It is
    // also why nothing is marked over a row that holds a value — the marker
    // means "this blank came from history", and putting it on a non-blank row
    // would be inventing it.
    item.value === "" && urlBlanked.has(item.key) ? { ...item, redacted: true } : item,
  )
}
