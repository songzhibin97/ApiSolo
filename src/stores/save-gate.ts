import { ref } from "vue"
import { defineStore } from "pinia"

import { identityTuple, type PendingField } from "../utils/pending-refill"

/**
 * Identifies a set of pending fields by what is pending, not by which button
 * asked. A field's identity is four components -- `kind`, `source`, `slot` and
 * `name` -- and nothing else; `name` is the raw position, so the signature does
 * not move when the interface language does. A different request produces a
 * different signature and has to be acknowledged on its own: a single global
 * "yes" would let the second request through unannounced, which is the failure
 * this gate exists to stop.
 *
 * Two entry points looking at the same request produce the same list and
 * therefore the same signature. That sentence stood here while it was false:
 * replaying a request emptied the body text, so the panel could only report a
 * single catch-all body entry -- or, once any edit cleared the marker, nothing
 * at all -- while the history row still named the individual keys.
 *
 * Each record is serialized rather than glued together with separators. `name`
 * is user input and may hold any character including a newline, so a delimited
 * encoding let one record impersonate two and one acknowledgement cover a list
 * the user never saw. `JSON.stringify` escapes quotes, backslashes and every
 * control character, which makes the encoding injective and the join
 * unambiguous.
 */
function signatureOf(fields: PendingField[]): string {
  return fields
    .map((field) => JSON.stringify(identityTuple(field)))
    .sort()
    .join("\n")
}

export const useSaveGateStore = defineStore("save-gate", () => {
  const acknowledgedSignature = ref("")

  function isAcknowledged(fields: PendingField[]) {
    return acknowledgedSignature.value === signatureOf(fields)
  }

  /**
   * The one question both save entry points ask. The answer depends on the
   * request's state, never on the caller's identity: keying off which button was
   * pressed is how the original save button ended up with no gate at all, and a
   * third entry point added later would have needed remembering too.
   */
  function blocksSave(fields: PendingField[]) {
    return fields.length > 0 && !isAcknowledged(fields)
  }

  function acknowledge(fields: PendingField[]) {
    acknowledgedSignature.value = signatureOf(fields)
  }

  function withdraw() {
    acknowledgedSignature.value = ""
  }

  return { isAcknowledged, blocksSave, acknowledge, withdraw }
})
