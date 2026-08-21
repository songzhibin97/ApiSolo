import { ref } from "vue"
import { defineStore } from "pinia"

import type { PendingField } from "../utils/pending-refill"

/**
 * Identifies a set of pending fields by what is pending, not by which button
 * asked. Two entry points looking at the same request produce the same list and
 * therefore the same signature, which is what makes one acknowledgement count
 * for both of them. A different request produces a different signature and has
 * to be acknowledged on its own -- a single global "yes" would let the second
 * request through unannounced, which is the failure this gate exists to stop.
 */
function signatureOf(fields: PendingField[]): string {
  return fields
    .map((field) => `${field.kind}|${field.source}|${field.path}`)
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
