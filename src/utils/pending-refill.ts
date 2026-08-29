import type { AuthConfig, KeyValuePair, RequestBody } from "../types"
import {
  REDACTION_SENTINEL,
  bodyKindFromBodyType,
  isUnverifiableBody,
  remainingRedactedBodyFieldLocations,
  sentinelBodyFieldLocations,
} from "./redaction"

/**
 * `refill-unverifiable` is its own class rather than a flag beside the list: it
 * has to travel with the fields so that both save entry points describe the
 * same request the same way. A flag returned alongside would only exist on the
 * panel side, the two signatures would diverge, and the user would be asked to
 * confirm the same request twice.
 */
export type PendingKind = "refill" | "reselect-file" | "refill-unverifiable"
export type PendingSource = "header" | "query" | "form" | "body" | "auth" | "file" | "binary"
export type NonAuthSource = Exclude<PendingSource, "auth">

/**
 * Which auth slot a pending entry sits in, as a value the user cannot supply.
 * The three auth entries share one `source`, so without this they would only be
 * told apart by `name` -- and the API key entry's name is the user's own key,
 * so naming a key `Bearer token` would collide two different pending items into
 * one acknowledgement.
 */
export type AuthSlot = "basic-password" | "bearer-token" | "api-key"

/**
 * `name` is the raw position, never display text: the user's own key, or "" for
 * a slot that has no user-supplied name. Display text is derived at render time
 * by `formatPendingField`. Keeping the two apart is what lets an acknowledgement
 * survive a language switch -- a localized string in here would make the
 * signature change with the interface language.
 */
export type PendingField =
  | { kind: PendingKind; source: NonAuthSource; name: string; segment?: number }
  | { kind: PendingKind; source: "auth"; slot: AuthSlot; name: string; segment?: number }

export type IdentityTuple = readonly [PendingKind, PendingSource, AuthSlot | null, string]

/**
 * The one place the four identity components are read off a field. Everything
 * that needs them -- the save gate's signature, the renderer, the tests -- calls
 * this rather than destructuring the union again, because a second copy of the
 * discriminant is a second thing to keep in step.
 */
export function identityTuple(f: PendingField): IdentityTuple {
  return [f.kind, f.source, f.source === "auth" ? f.slot : null, f.name] as const
}

/**
 * Everything the check needs, and nothing that says where the request came
 * from. A `Tab` satisfies this shape as-is, and a history entry is adapted into
 * it by `historyEntryToRequest`, so both save entry points run the same check
 * against the same criteria. Keying off the caller instead would mean each new
 * entry point has to be remembered separately -- which is how the old save
 * button ended up with no gate at all.
 */
export interface PendingRefillSource {
  url: string
  headers: KeyValuePair[]
  params: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
  bodyRedactedFields?: string[]
}

/**
 * `Record`, not `Partial`: adding a source without giving it a word stops
 * compiling rather than reaching a screen as a raw key.
 */
const SOURCE_KEY: Record<PendingSource, string> = {
  header: "pendingField.sourceHeader",
  query: "pendingField.sourceQuery",
  form: "pendingField.sourceForm",
  body: "pendingField.sourceBody",
  auth: "pendingField.sourceAuth",
  file: "pendingField.sourceForm",
  binary: "pendingField.sourceBody",
}

const AUTH_SLOT_KEY: Record<AuthSlot, string> = {
  "basic-password": "pendingField.authBasicPassword",
  "bearer-token": "pendingField.authBearerToken",
  "api-key": "pendingField.authApiKeyNamed",
}

const GROUP_TITLE_KEY: Record<PendingKind, string> = {
  refill: "history.refillTitle",
  "refill-unverifiable": "history.refillUnparseableBody",
  "reselect-file": "history.reselectFileTitle",
}

export type TranslateFn = (key: string, named?: Record<string, unknown>) => string

export function pendingGroupTitleKey(kind: PendingKind): string {
  return GROUP_TITLE_KEY[kind]
}

function positionName(
  source: PendingSource,
  slot: AuthSlot | null,
  name: string,
  t: TranslateFn,
): string {
  if (slot === "api-key") {
    return name ? t(AUTH_SLOT_KEY[slot], { key: name }) : t("pendingField.authApiKeyUnnamed")
  }

  if (slot) {
    return t(AUTH_SLOT_KEY[slot])
  }

  // Names the user wrote are shown as written; only structural positions are
  // translated. The binary body has no user-supplied name to show when history
  // kept no file name for it.
  if (source === "binary" && !name) {
    return t("pendingField.binaryBodyUnnamed")
  }

  return name
}

/**
 * The only place a pending entry turns into text on screen. A bare field name
 * cannot be located -- `password` can be a header, a form row and a JSON key on
 * the same request -- so the position is spelled out here rather than stored on
 * the field, where it would follow the acknowledgement around and break it on a
 * language switch.
 */
export function formatPendingField(f: PendingField, t: TranslateFn): string {
  const [, source, slot, name] = identityTuple(f)

  return `${t(SOURCE_KEY[source])} · ${positionName(source, slot, name, t)}`
}

function field(
  kind: PendingKind,
  source: NonAuthSource,
  name: string,
  segment?: number,
): PendingField {
  return { kind, source, name, ...(segment === undefined ? {} : { segment }) }
}

/**
 * Auth entries get their own constructor so the slot cannot be forgotten: it is
 * a required positional argument here and a required member on the union, which
 * makes "an auth entry with no slot" unrepresentable rather than merely untested.
 */
function authField(kind: PendingKind, slot: AuthSlot, name: string): PendingField {
  return { kind, source: "auth", slot, name }
}

/**
 * Two spellings of the same fact. A row read straight off disk still holds the
 * placeholder; a row that has been through the replay path holds an empty value
 * and a marker instead, because the placeholder must never be replayable. Both
 * mean "the user has to type this back in".
 *
 * Exported because the editor renders the same fact and must not spell it
 * differently. Asking only whether the marker is set is a different question
 * with a different answer: the marker outlives the value it was set for, so a
 * row that has been filled back in still carries it, and a renderer keyed on
 * the marker alone would keep telling the user to re-enter something they
 * already typed.
 */
export function needsRefill(item: KeyValuePair): boolean {
  return item.value.trim() === REDACTION_SENTINEL || (item.redacted === true && item.value === "")
}

function pairFields(items: KeyValuePair[], source: NonAuthSource): PendingField[] {
  // Disabled rows remain here intentionally: the save gate asks whether
  // persistence would write an empty credential, not whether the row is sent.
  return items.filter(needsRefill).map((item) => field("refill", source, item.key))
}

/**
 * The auth slots never carry a placeholder -- history blanks them outright --
 * so a check that only looks for placeholders returns an empty list for a
 * request with a Bearer token and the save goes through unannounced.
 */
function authFields(auth: AuthConfig): PendingField[] {
  if (auth.type === "basic" && !auth.basic?.password) {
    return [authField("refill", "basic-password", "")]
  }

  if (auth.type === "bearer" && !auth.bearer?.token) {
    return [authField("refill", "bearer-token", "")]
  }

  if (auth.type === "api-key" && !auth.apiKey?.value) {
    return [authField("refill", "api-key", auth.apiKey?.key || "")]
  }

  return []
}

function bodyFields(source: PendingRefillSource): PendingField[] {
  const { body } = source

  if (body.type === "form-data") {
    return pairFields(
      body.formData.filter((item) => item.valueType !== "file"),
      "form",
    )
  }

  if (body.type === "binary" || body.type === "none") {
    return []
  }

  const kind = bodyKindFromBodyType(body.type)
  // A property of the body text, worked out once and stamped on whichever
  // branch below produces the names. Deciding it per branch would give the two
  // save entry points different answers for the same request.
  const pendingKind: PendingKind = isUnverifiableBody(kind, body.content)
    ? "refill-unverifiable"
    : "refill"

  const named = sentinelBodyFieldLocations(kind, body.content)
  if (named.length > 0) {
    return named.map(({ name, segment }) => field(pendingKind, "body", name, segment))
  }

  // Replay already stripped the placeholders out of the body text, so the keys
  // cannot be found there any more. They were written down when they were
  // cleared; which of them still need typing back in is decided by what the
  // body holds now, not by whether anything has been edited since.
  return remainingRedactedBodyFieldLocations(
    kind,
    body.content,
    source.bodyRedactedFields ?? [],
  ).map(({ name, segment }) => field(pendingKind, "body", name, segment))
}

/**
 * File content is not redacted, it is absent: history keeps neither the bytes
 * nor the path, only a bare file name. Nothing about these rows looks rewritten,
 * so any check phrased as "which values look like they were replaced" misses
 * them entirely and hands back a request that can never be sent.
 */
function fileFields(body: RequestBody): PendingField[] {
  if (body.type === "form-data") {
    return body.formData
      .filter((item) => item.valueType === "file")
      .map((item) => field("reselect-file", "file", item.key))
  }

  if (body.type === "binary" && !body.binaryContent) {
    // No fallback word here: an empty name is the fact, and the renderer is
    // where it turns into something the user can read in their own language.
    return [field("reselect-file", "binary", body.binaryPath)]
  }

  return []
}

function queryFields(source: PendingRefillSource): PendingField[] {
  // Imports reconcile the two query copies once. Reading the gate is strictly
  // per row; propagating markers by key here would mark rows added by the user.
  return pairFields(source.params, "query")
}

export function pendingRefillFields(source: PendingRefillSource): PendingField[] {
  const fields = [
    ...pairFields(source.headers, "header"),
    ...queryFields(source),
    ...bodyFields(source),
    ...authFields(source.auth),
    ...fileFields(source.body),
  ]

  return fields
}

export function refillFields(fields: PendingField[]): PendingField[] {
  return fields.filter((item) => item.kind === "refill")
}

export function unverifiableFields(fields: PendingField[]): PendingField[] {
  return fields.filter((item) => item.kind === "refill-unverifiable")
}

export function reselectFileFields(fields: PendingField[]): PendingField[] {
  return fields.filter((item) => item.kind === "reselect-file")
}

/**
 * What the always-on notice above the request says. It is the save gate's own
 * list minus the files, so the two cannot contradict each other -- they used to
 * be derived separately, and by the time anyone looked the gate was holding
 * saves for a blanked Bearer token that the notice never mentioned.
 *
 * Files are left out on a criterion, not for convenience: a dropped upload
 * already shows as "no file selected" in the body editor, so the notice would
 * be repeating a message the screen is carrying. A blanked auth slot or body
 * key has nothing on screen pointing at it.
 */
export function bannerFields(fields: PendingField[]): PendingField[] {
  return fields.filter((item) => item.kind !== "reselect-file")
}
