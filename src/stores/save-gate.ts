import { ref } from "vue"
import { defineStore } from "pinia"

import { identityTuple, type PendingField } from "../utils/pending-refill"

/**
 * Build the caller-independent signature used by the shared save acknowledgement.
 * `KeyValuePair.redacted` owns row-marker semantics; `identityTuple` owns pending
 * field identity. Serializing each tuple separately keeps user input from changing
 * record boundaries before the records are sorted and joined.
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
