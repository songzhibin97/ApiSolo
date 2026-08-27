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
 * Which keys this entry blanked is a second question, and it is asked of both
 * copies together. The two do not spell the answer the same way — the url
 * redactor stamps a placeholder on any sensitive key, while the pair redactor
 * leaves an already empty value alone — so either copy can be the only one that
 * still says a key was blanked, and neither ever contradicts the other on it.
 * Marked per key rather than per row, for the reason set out above
 * `syncParamsFromUrl`: two identical blank parameters hold no fact saying which
 * is which.
 *
 * This used to read the url's answer *minus* the keys the params copy reports
 * as blanked, to keep a key from being "counted twice". It counted nothing
 * twice — a row holding the placeholder is not empty, so the marker never lands
 * on it and it is already reported by the placeholder alone — and what the
 * subtraction did drop was the key both copies name, which is the shape most in
 * need of reporting: `apikey=SECRET&apikey=` comes back as one placeholder row
 * and one blank row, the subtraction left the blank row unmarked, and typing
 * the credential back into the marked row emptied the list, took the notice
 * down, unlocked the save and wrote `apikey=""` into the collection.
 *
 * The blank row in that pair may well be one the user meant to send empty. The
 * entry holds no fact that separates it from a credential blanked by an earlier
 * generation of the same row and never typed back in — the url stamps both the
 * same way — so this errs where the rest of the slice errs, per
 * `applyPairEdit`: over-reporting costs a confirmation, under-reporting costs a
 * credential.
 *
 * This lives in its own module because it is the *one* answer to the question,
 * not one of two. Both save entry points reach it — the panel through the rows
 * this builds for the tab, the history row through `queryFields` in
 * `pending-refill.ts` — and when the two had a rule each they disagreed about
 * the same row: a key the url still spelled `[redacted]` while the params copy
 * held the value already typed back in was listed as outstanding by the history
 * row and as done by the panel. Adding a case to one of two rules is what put
 * that disagreement there; a second rule is not to be written here again.
 *
 * The panel's params table is held to the same rule: it renders this
 * function's output rather than the raw `tab.params`, so its amber mark
 * (`needsRefill` per row) and the pending list (`needsRefill` over the same
 * rows) are two readings of one computation. Handing the table the raw rows
 * was the same defect one layer up — a blank row this marks at read time was
 * named by the notice and held by the gate while no box on screen pointed at
 * it.
 */
export function historyQueryRows(stored: KeyValuePair[], rawUrl: string): KeyValuePair[] {
  const fromUrl = deriveParamsFromUrl(rawUrl)

  /**
   * Says a row was blanked, in either of the two spellings the fact has: a row
   * read straight off disk still holds the placeholder, a row that has been
   * through the replay path holds the marker instead. Deliberately *not*
   * `needsRefill`, which adds "and is still empty": that answers a per-row
   * question, and the set below is a per-key one. A key would stop counting as
   * blanked the moment its last blank row was filled, which is exactly when
   * emptying one again has to be reported.
   */
  const isBlanked = (item: KeyValuePair) =>
    item.value.trim() === REDACTION_SENTINEL || item.redacted === true

  // Which keys the params copy speaks for. A question about *rows*: params are
  // what the send path puts on the wire, so a key they list is a key they own,
  // and the url may only contribute rows for keys they never had.
  const storedKeys = new Set(stored.map((item) => item.key))
  // Which keys this entry blanked. A question about *keys*, answered by the two
  // copies together — the union, not one of them minus the other.
  const blankedKeys = new Set([...stored, ...fromUrl].filter(isBlanked).map((item) => item.key))

  return [...stored, ...fromUrl.filter((item) => !storedKeys.has(item.key))].map((item) =>
    // `value === ""` is what keeps the two entry points agreeing on a key whose
    // copies disagree: the url still holding a placeholder for a key the params
    // copy holds a real value for says only that the url is stale, and marking
    // the filled row would gate a request the user has already completed. It is
    // also why nothing is marked over a row that holds a value — the marker
    // means "this blank came from history", and putting it on a non-blank row
    // would be inventing it.
    item.value === "" && blankedKeys.has(item.key) ? { ...item, redacted: true } : item,
  )
}
