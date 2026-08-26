import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import { useSaveGateStore } from "../save-gate"
import { identityTuple, type PendingField, type PendingSource } from "../../utils/pending-refill"

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * `signatureOf` is deliberately private, so every question here is asked of the
 * gate itself: acknowledge one list, then ask whether another counts as
 * acknowledged. That is the behaviour the rest of the app depends on, and it
 * cannot be satisfied by a helper that is never called.
 */
function merges(a: PendingField[], b: PendingField[]): boolean {
  const gate = useSaveGateStore()
  gate.acknowledge(a)
  return gate.isAcknowledged(b)
}

/**
 * A frozen copy of the encoding this slice replaced: three components joined
 * with `|`, the third being the display text.
 *
 * It is written out here rather than derived from the current renderer because
 * the renderer's output is deliberately different now -- the labels are
 * localized. It was checked against the live renderer, string for string, in
 * 32705ac, the commit that introduced this file while the old text was still
 * being produced. From here on it is a historical constant and must not be
 * updated to follow the renderer: that is the whole point of comparing to it.
 */
const LEGACY_SOURCE_LABEL: Record<PendingSource, string> = {
  header: "Header",
  query: "Query",
  form: "Form",
  body: "Body",
  auth: "Auth",
  file: "Form",
  binary: "Body",
}

function legacyPath(f: PendingField): string {
  const [, source, slot, name] = identityTuple(f)
  const label = LEGACY_SOURCE_LABEL[source]

  if (slot === "basic-password") return `${label} · Basic password`
  if (slot === "bearer-token") return `${label} · Bearer token`
  if (slot === "api-key") return `${label} · API key ${name || "value"}`
  if (source === "binary" && !name) return `${label} · binary body`

  return `${label} · ${name}`
}

function legacySignature(fields: PendingField[]): string {
  return fields
    .map((f) => `${f.kind}|${f.source}|${legacyPath(f)}`)
    .sort()
    .join("\n")
}

const header = (name: string): PendingField => ({ kind: "refill", source: "header", name })
const query = (name: string): PendingField => ({ kind: "refill", source: "query", name })
const body = (name: string): PendingField => ({ kind: "refill", source: "body", name })
const basic = (): PendingField => ({
  kind: "refill",
  source: "auth",
  slot: "basic-password",
  name: "",
})
const bearer = (): PendingField => ({
  kind: "refill",
  source: "auth",
  slot: "bearer-token",
  name: "",
})
const apiKey = (name: string): PendingField => ({
  kind: "refill",
  source: "auth",
  slot: "api-key",
  name,
})

describe("the reference encoding this suite compares against is the real old one", () => {
  // Pins the frozen constant so a later edit cannot quietly make it agree with
  // whatever the renderer does today, which would turn every comparison below
  // into a comparison of the new encoding with itself.
  it("still spells out the strings the replaced `path` field held", () => {
    expect(legacyPath(header("Authorization"))).toBe("Header · Authorization")
    expect(legacyPath(query("apikey"))).toBe("Query · apikey")
    expect(legacyPath(body("token"))).toBe("Body · token")
    expect(legacyPath(basic())).toBe("Auth · Basic password")
    expect(legacyPath(bearer())).toBe("Auth · Bearer token")
    expect(legacyPath(apiKey("X-Api-Key"))).toBe("Auth · API key X-Api-Key")
    expect(legacyPath(apiKey(""))).toBe("Auth · API key value")
  })
})

/**
 * The proof obligation for changing how a signature is encoded: the new
 * encoding must not merge two lists the old one told apart, and must not split
 * two lists the old one treated as one. Byte equality is not required and not
 * claimed -- the API key entry's identity genuinely changed value, because its
 * name used to have a display word glued onto the front of it.
 *
 * The corpus is delimiter-free on purpose. Outside that set the two encodings
 * deliberately disagree, and that disagreement is the defect being fixed; it is
 * pinned separately below.
 */
describe("the signature encoding changed one-to-one over delimiter-free lists", () => {
  const corpus: PendingField[][] = [
    [],
    [header("Authorization")],
    [header("Cookie")],
    [query("apikey")],
    [body("token")],
    [body("token"), body("token")],
    [body("token"), query("apikey")],
    [header("token")],
    [basic()],
    [bearer()],
    [apiKey("")],
    [apiKey("X-Api-Key")],
    [apiKey("Bearer token")],
    [apiKey("bearer-token")],
    [basic(), bearer(), apiKey("")],
    [{ kind: "reselect-file", source: "file", name: "avatar" }],
    [{ kind: "reselect-file", source: "binary", name: "photo.png" }],
    [{ kind: "reselect-file", source: "file", name: "token" }],
  ]

  it("covers every pair in both directions", () => {
    const disagreements: string[] = []

    for (const a of corpus) {
      for (const b of corpus) {
        const before = legacySignature(a) === legacySignature(b)
        const after = merges(a, b)

        if (before !== after) {
          disagreements.push(
            `${JSON.stringify(a)} vs ${JSON.stringify(b)}: was ${before}, now ${after}`,
          )
        }
      }
    }

    expect(disagreements).toEqual([])
    // The corpus has to be big enough for the statement above to mean anything.
    expect(corpus.length * corpus.length).toBe(324)
  })

  it("tells the three auth slots apart even when the user names a key after one", () => {
    // Under the old encoding this worked by accident: the display text carried
    // an "API key " prefix. The slot makes it structural.
    expect(merges([apiKey("Bearer token")], [bearer()])).toBe(false)
    expect(merges([apiKey("")], [basic()])).toBe(false)
    expect(merges([apiKey("")], [apiKey("")])).toBe(true)
  })
})

/**
 * The live defect this encoding change fixes. `name` is user input and may hold
 * any character, so joining records with a separator let one field impersonate
 * a whole different list: acknowledge A, and B -- which the user never saw --
 * counts as acknowledged and saves blank.
 */
describe("a field name cannot impersonate a different pending list", () => {
  // P6: built at runtime rather than written as an escape, so the payload
  // cannot be silently flattened on its way into the file.
  const NEWLINE = String.fromCharCode(10)
  const injected = body(`token${NEWLINE}refill|query||apikey`)
  const twoOrdinary = [body("token"), query("apikey")]

  it("the payload really carries a raw newline", () => {
    expect(injected.name).toContain(NEWLINE)
    expect(injected.name.split(NEWLINE)).toHaveLength(2)
  })

  it("does not hand one field's acknowledgement to a two-field list", () => {
    const gate = useSaveGateStore()
    gate.acknowledge([injected])

    expect(gate.isAcknowledged(twoOrdinary)).toBe(false)
    expect(gate.blocksSave(twoOrdinary)).toBe(true)
  })

  // The same payload written for the encoding that shipped, kept so the
  // regression is anchored to the shape that was actually broken rather than to
  // the shape this slice introduced.
  it("was a real collision under the encoding this replaced", () => {
    const shipped = body(`token${NEWLINE}refill|query|Query · apikey`)

    expect(legacySignature([shipped])).toBe(legacySignature(twoOrdinary))
    expect(merges([shipped], twoOrdinary)).toBe(false)
  })

  // Without this the two tests above would also pass on a gate that answers
  // "no" to everything.
  it("still recognises a list it has actually seen", () => {
    expect(merges(twoOrdinary, twoOrdinary)).toBe(true)
    expect(merges([injected], [injected])).toBe(true)
  })
})
