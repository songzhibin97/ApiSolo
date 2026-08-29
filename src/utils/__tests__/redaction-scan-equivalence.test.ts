import { describe, expect, it } from "vitest"
import { loadavg } from "node:os"

import {
  REDACTION_SENTINEL,
  clearSentinelBody,
  emptyBodyFields,
  firstSensitiveCut,
  isSensitiveKey,
  redactBodyText,
  sentinelBodyFields,
} from "../redaction"

// ---------------------------------------------------------------------------
// D18 - the equivalence apparatus for the linear `firstSensitiveCut`.
//
// This file is not a list of invariants with one assertion each; it is a single
// instrument for one claim: the linear scan and the backtracking regex it
// replaced return the same thing for every input. It holds a frozen copy of
// that regex, a corpus generator, negative controls for its own comparator, a
// reconciliation of the character classes across the whole code-unit space, and
// a written-down boundary table.
//
// DO NOT "tidy up" the frozen oracle below. It is deliberately dead-looking
// history: it is the only surviving copy of the predicate this module used to
// ship, and every "zero differences" reading in here is measured against it.
// ---------------------------------------------------------------------------

// P6: this repo's writing chain has silently eaten escape sequences in fixtures
// before, and a test that asserts on the wrong input is worse than no test. So
// every delicate code unit is constructed at runtime and self-checked.
const VT = String.fromCharCode(11) // vertical tab - NOT a blank to this scanner
const FF = String.fromCharCode(12) // form feed    - NOT a blank to this scanner
const NBSP = String.fromCharCode(160) // no-break space - NOT a blank either
const NUL = String.fromCharCode(0)
const ASTRAL = String.fromCharCode(0xd83d, 0xde00) // one code point, two units

// ---------------------------------------------------------------------------
// L0 - the frozen oracle
// ---------------------------------------------------------------------------

type Cut = ReturnType<typeof firstSensitiveCut>

/**
 * The scan regex exactly as this module shipped it before D18, character for
 * character. A HISTORICAL ANCHOR: it must never be "updated" to track the
 * product. If somebody changes what counts as a key or a separator, the
 * differential assertions below are supposed to go red -- that is their
 * purpose, not a bug in them.
 *
 * `isSensitiveKey` is imported rather than copied: D18 does not touch the
 * sensitivity rule, so both sides must consult the same one.
 */
type OracleDefect = "faithful" | "wrong-key" | "cut-minus-one" | "no-sensitivity-test"

function oracle(line: string, defect: OracleDefect = "faithful"): Cut {
  const scan = /["']?([A-Za-z0-9_.\-]+)["']?[ \t]*[:=][ \t]*/g
  let match: RegExpExecArray | null

  while ((match = scan.exec(line)) !== null) {
    const sensitive = defect === "no-sensitivity-test" ? true : isSensitiveKey(match[1])

    if (sensitive) {
      return {
        key: defect === "wrong-key" ? "WRONG" : match[1],
        cut: match.index + match[0].length - (defect === "cut-minus-one" ? 1 : 0),
      }
    }
  }

  return null
}

/** The oracle wearing `redactText`'s clothes, for the performance rungs. */
function oracleRedactText(content: string): string {
  const parts = content.split(/(\r\n|\n|\r)/)

  for (let k = 0; k < parts.length; k += 2) {
    const hit = oracle(parts[k])
    parts[k] = hit ? parts[k].slice(0, hit.cut) + REDACTION_SENTINEL : parts[k]
  }

  return parts.join("")
}

function sameCut(a: Cut, b: Cut): boolean {
  if (a === null || b === null) return a === b
  return a.key === b.key && a.cut === b.cut
}

// ---------------------------------------------------------------------------
// L1 - the corpus
//
// Why a 16-symbol alphabet exhausted to depth 4 covers "any input", in two
// steps:
//
//   Character dimension - the scan only ever asks which class a character is
//   in, so same-class characters are interchangeable to it. The one exception
//   is that key characters also reach `isSensitiveKey`, where they are not.
//   Hence one representative per class, plus the fragments needed to spell a
//   sensitive key whole and across symbol boundaries. EQ-3/EQ-4 below are what
//   license that step: they check the classes over all 65,536 code units.
//
//   Structure dimension - the scan decides using a five-position window
//   (optional quote, run, optional quote, blanks, separator), so exhausting
//   every sequence of five adjacent symbols covers every decision it can make.
//   THIS STEP IS AN ARGUMENT, NOT AN ENUMERATION, and it is the weakest link
//   in the whole file: it is sound only while the scan keeps a five-position
//   window. Widening that window invalidates it, and running the corpus deeper
//   is not a repair -- a counterexample spanning seven symbols escapes a
//   depth-six corpus just as well.
// ---------------------------------------------------------------------------

const ALPHABET = [
  "token",
  "tok",
  "en",
  "TOK",
  "a",
  "0",
  "_",
  ".",
  "-",
  "\"",
  "'",
  " ",
  "\t",
  ":",
  "=",
  "@",
]

const FIXTURES = [
  "",
  "token=abc",
  "token:abc",
  "Authorization: Bearer abcdef",
  "authorization:Bearer x",
  "AUTHORIZATION = x",
  "Cookie: a=1; b=2",
  "Set-Cookie: sid=deadbeef; Path=/; HttpOnly",
  "x-api-key: k-1",
  "X-API-KEY=k-1",
  "api-key: k",
  "apikey=k",
  "subscription-key: s",
  "signature=abc",
  "credential=abc",
  "password=hunter2",
  "passwd:hunter2",
  "secret = s",
  "monkey=not-sensitive",
  "no-separator-at-all-in-this-line",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVP",
  "curl -H 'Authorization: Bearer abc' https://example.com/a",
  "curl -H \"X-Api-Key: abc\" https://example.com",
  "GET /v1/things?token=abc&page=2 HTTP/1.1",
  "POST /login HTTP/1.1",
  "token=abc\ntoken=def",
  "token=abc\r\ntoken=def",
  "token=abc\rtoken=def",
  "a\n\nb",
  "token=[redacted]",
  "token=[redacted]\nsecret=[redacted]",
  "token=",
  "token:",
  "token:    ",
  "\"token\": \"abc\"",
  "'token' : 'abc'",
  "{\"token\":\"abc\",\"other\":1}",
  "token%3Dabc",
  "token=%2Fpath%2F",
  "token" + NUL + "=abc",
  "token=" + NUL,
  "token" + VT + "=abc",
  "token" + NBSP + "=abc",
  "token=" + ASTRAL,
  ASTRAL + "=abc",
  "token=" + String.fromCharCode(0xd83d),
  "a".repeat(600) + " token=abc",
]

const FUZZ_COUNT = 200000
const FUZZ_SEED = 3352

/** Deterministic, so every count in this file is reproducible. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const DEFAULT_DEPTH = 4

// Depth 7 would be 268,435,456 exhaustive strings, all materialised in one
// array; it exhausts memory rather than finishing. The range therefore stops at
// 6, which is the deepest anybody has run (18,095,744 strings, ~38 s, once, by
// the spec review).
const MAX_DEPTH = 6

/**
 * Depth 4 is the committed size (269,952 strings, well under a second). Depth 5
 * is 1,318,528 and is what a reviewer runs by hand:
 *
 *   D18_SCAN_DEPTH=5 npx vitest run redaction-scan-equivalence
 *
 * Only an environment variable is read; no product-side switch exists.
 *
 * FAIL-CLOSED, and not as a matter of taste (D18 R1 finding I2). This was a
 * bare `Number(process.env.D18_SCAN_DEPTH ?? "4")`. `Number("not-a-depth")` is
 * NaN, `for (d = 1; d <= NaN; ...)` never enters even once, and the entire
 * exhaustive corpus silently vanished -- while the run still reported 60/60
 * green in 1.27 s against depth 4's 1.47 s. Nothing in the output said the
 * enumeration had not happened, so "the harness was silent" read as "it ran and
 * found nothing".
 *
 * An unusable value must abort. It must also NOT fall back to the default:
 * falling back turns "I ran depth 6" into a silent depth 4, which is the same
 * lie one step quieter.
 */
function resolveDepth(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DEPTH

  const trimmed = raw.trim()
  const depth = Number(trimmed)

  if (trimmed === "" || !Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new Error(
      `D18_SCAN_DEPTH must be an integer from 1 to ${MAX_DEPTH}; got ${JSON.stringify(raw)}. ` +
        "Refusing to run: an unusable depth skips the exhaustive corpus and still reports green.",
    )
  }

  return depth
}

const DEPTH = resolveDepth(process.env.D18_SCAN_DEPTH)

/**
 * Returns the corpus AND `levels` -- how many strings were actually generated
 * at each depth. `levels` is not decoration: it is the only value in this file
 * that can tell "the enumeration ran to depth N" apart from "the loop never
 * entered". Every `mismatches === 0` below is a count over CORPUS, and a count
 * that cannot say which enumeration produced it is exactly the reading that
 * hid finding I2 for a whole implementation round.
 */
function buildCorpus(depth: number): { corpus: string[]; levels: number[] } {
  const corpus: string[] = [""]
  const levels: number[] = []
  let frontier: string[] = [""]

  for (let d = 1; d <= depth; d += 1) {
    const next: string[] = []
    for (const prefix of frontier) {
      for (const symbol of ALPHABET) {
        const s = prefix + symbol
        next.push(s)
        corpus.push(s)
      }
    }
    levels.push(next.length)
    frontier = next
  }

  for (const fixture of FIXTURES) corpus.push(fixture)

  const random = mulberry32(FUZZ_SEED)
  for (let n = 0; n < FUZZ_COUNT; n += 1) {
    const length = 1 + Math.floor(random() * 12)
    let s = ""
    for (let k = 0; k < length; k += 1) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
    corpus.push(s)
  }

  return { corpus, levels }
}

const { corpus: CORPUS, levels: CORPUS_LEVELS } = buildCorpus(DEPTH)
const EXHAUSTIVE_COUNT = 1 + CORPUS_LEVELS.reduce((sum, count) => sum + count, 0)

// Make the reading carry its own provenance: whatever "mismatches = 0" means
// below, it means it over this corpus, printed by the same run that produced it.
console.info(
  `[D18] corpus depth=${DEPTH} levels=[${CORPUS_LEVELS.join(", ")}] ` +
    `exhaustive=${EXHAUSTIVE_COUNT} fixtures=${FIXTURES.length} fuzz=${FUZZ_COUNT} ` +
    `total=${CORPUS.length}`,
)

/** Counts one mismatch per corpus string; the unit is strings, not characters. */
function countMismatches(left: (s: string) => Cut, right: (s: string) => Cut): number {
  let mismatches = 0
  for (const s of CORPUS) {
    if (!sameCut(left(s), right(s))) mismatches += 1
  }
  return mismatches
}

// ---------------------------------------------------------------------------
// L2 - a second scanner, used ONLY to prove the comparator can see defects.
//
// This is not the product and must never be mistaken for it. It is a knob-fitted
// linear scan whose `"none"` setting reproduces the algorithm and whose other
// settings each break it in one specific way. Without it, "zero differences"
// would be indistinguishable from a comparator that cannot see anything --
// which is the failure this repo has hit repeatedly: a layer that really runs,
// really reports zero, and answers a different question.
// ---------------------------------------------------------------------------

type ScanDefect =
  | "none"
  | "drop-hyphen-from-key-class"
  | "cut-before-trailing-blanks"
  | "resume-at-key-start-plus-one"
  | "skip-leading-quote"
  | "jump-to-j-plus-1"
  | "jump-to-j-plus-2"
  | "no-closing-quote"
  | "no-blanks-before-separator"
  | "key-includes-closing-quote"
  | "require-leading-quote"

function variantScan(line: string, defect: ScanDefect): Cut {
  const isKey = (c: number) =>
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 46 ||
    (c === 45 && defect !== "drop-hyphen-from-key-class")
  const isQuote = (c: number) => c === 34 || c === 39
  const isBlank = (c: number) => c === 32 || c === 9
  const isSep = (c: number) => c === 58 || c === 61

  const n = line.length
  let i = 0

  while (i < n) {
    let j = i
    let sawLeadingQuote = false

    if (defect !== "skip-leading-quote" && isQuote(line.charCodeAt(j))) {
      j += 1
      sawLeadingQuote = true
    }

    if (defect === "require-leading-quote" && !sawLeadingQuote) {
      i += 1
      continue
    }

    const keyStart = j
    while (j < n && isKey(line.charCodeAt(j))) j += 1

    if (j === keyStart) {
      i += 1
      continue
    }

    let k = j
    let keyEnd = j

    if (defect !== "no-closing-quote" && k < n && isQuote(line.charCodeAt(k))) {
      k += 1
      if (defect === "key-includes-closing-quote") keyEnd = k
    }

    if (defect !== "no-blanks-before-separator") {
      while (k < n && isBlank(line.charCodeAt(k))) k += 1
    }

    if (k < n && isSep(line.charCodeAt(k))) {
      k += 1
      const afterSeparator = k
      while (k < n && isBlank(line.charCodeAt(k))) k += 1

      const key = line.slice(keyStart, keyEnd)
      if (isSensitiveKey(key)) {
        return { key, cut: defect === "cut-before-trailing-blanks" ? afterSeparator : k }
      }

      i = defect === "resume-at-key-start-plus-one" ? keyStart + 1 : k
      continue
    }

    if (defect === "jump-to-j-plus-1") i = j + 1
    else if (defect === "jump-to-j-plus-2") i = j + 2
    else i = j
  }

  return null
}

// ---------------------------------------------------------------------------
// L3 - character classes, read out of the SHIPPED scan
//
// The four predicates are module-private and the scope for this change forbids
// exporting them, so their membership is recovered by probing
// `firstSensitiveCut` itself. That is stronger than exporting a copy would be:
// these probes observe the classes the product actually scans with, not a
// second definition that could drift from it.
//
// The regexes on the right are HISTORICAL ANCHORS from the pre-D18 scan regex.
// ---------------------------------------------------------------------------

const RX_KEY = /[A-Za-z0-9_.\-]/
const RX_QUOTE = /["']/
const RX_BLANK = /[ \t]/
const RX_SEP = /[:=]/

// "token<ch>=v": if <ch> joins the key run the reported key grows by it.
const probeKey = (ch: string) => {
  const hit = firstSensitiveCut(`token${ch}=v`)
  return hit !== null && hit.key === `token${ch}`
}
// A quote is consumed once and only once, so doubling it kills the match.
const probeQuote = (ch: string) => {
  const hit = firstSensitiveCut(`token${ch}=v`)
  return (
    hit !== null && hit.key === "token" && hit.cut === 7 && firstSensitiveCut(`token${ch}${ch}=v`) === null
  )
}
// Blanks are consumed greedily, so doubling one just moves the cut along.
const probeBlank = (ch: string) => {
  const hit = firstSensitiveCut(`token${ch}${ch}=v`)
  return hit !== null && hit.key === "token" && hit.cut === 8
}
// "token<ch>v" matches only if <ch> is itself a separator.
const probeSep = (ch: string) => firstSensitiveCut(`token${ch}v`) !== null

// ---------------------------------------------------------------------------
// L4 - the boundary table
//
// Generated by walking TECH 2.3's exit enumeration: every position where the
// scan looks at one more character, crossed with the class that character can
// be in. The expected values are the pre-D18 module's real output, not
// hand-computed -- so this table is a regression lock independent of the
// oracle. If the oracle and the product ever went wrong together, L1 would go
// green and this would not.
// ---------------------------------------------------------------------------

interface BoundaryCase {
  name: string
  input: string
  redact: string
  clearedContent: string
  clearedFields: string[]
  sentinel: string[]
  empty: string[] | null
}

const BOUNDARY: BoundaryCase[] = [
  { name: "C01", input: "token=v", redact: "token=[redacted]", clearedContent: "token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C02", input: "token:v", redact: "token:[redacted]", clearedContent: "token:v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C03", input: "token= v", redact: "token= [redacted]", clearedContent: "token= v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C04", input: "token\"=v", redact: "token\"=[redacted]", clearedContent: "token\"=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C05", input: "token =v", redact: "token =[redacted]", clearedContent: "token =v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C06", input: "mytoken=v", redact: "mytoken=[redacted]", clearedContent: "mytoken=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C07", input: "secret:1", redact: "secret:[redacted]", clearedContent: "secret:1", clearedFields: [], sentinel: [], empty: [] },
  { name: "C08", input: "\"token\"=v", redact: "\"token\"=[redacted]", clearedContent: "\"token\"=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C09", input: "token:", redact: "token:[redacted]", clearedContent: "token:", clearedFields: [], sentinel: [], empty: ["token"] },
  { name: "C10", input: "token:   ", redact: "token:   [redacted]", clearedContent: "token:   ", clearedFields: [], sentinel: [], empty: ["token"] },
  { name: "C11", input: "token:\tv", redact: "token:\t[redacted]", clearedContent: "token:\tv", clearedFields: [], sentinel: [], empty: [] },
  { name: "C12", input: "token\t=\tv", redact: "token\t=\t[redacted]", clearedContent: "token\t=\tv", clearedFields: [], sentinel: [], empty: [] },
  { name: "C13", input: "ab token=v", redact: "ab token=[redacted]", clearedContent: "ab token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C14", input: "abc=1 token=2", redact: "abc=1 token=[redacted]", clearedContent: "abc=1 token=2", clearedFields: [], sentinel: [], empty: [] },
  { name: "C15", input: "@token=v", redact: "@token=[redacted]", clearedContent: "@token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C16", input: "token", redact: "token", clearedContent: "token", clearedFields: [], sentinel: [], empty: [] },
  { name: "C17", input: "TOKEN=v", redact: "TOKEN=[redacted]", clearedContent: "TOKEN=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C18", input: "ToKeN=v", redact: "ToKeN=[redacted]", clearedContent: "ToKeN=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C19", input: "x_token=v", redact: "x_token=[redacted]", clearedContent: "x_token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C20", input: "0token=v", redact: "0token=[redacted]", clearedContent: "0token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C21", input: "token.x=v", redact: "token.x=[redacted]", clearedContent: "token.x=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C22", input: "x-api-key=v", redact: "x-api-key=[redacted]", clearedContent: "x-api-key=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C23", input: "token:::v", redact: "token:[redacted]", clearedContent: "token:::v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C24", input: "token\"", redact: "token\"", clearedContent: "token\"", clearedFields: [], sentinel: [], empty: [] },
  { name: "C25", input: "token=[redacted]", redact: "token=[redacted]", clearedContent: "token=", clearedFields: ["token"], sentinel: ["token"], empty: [] },
  { name: "C26", input: "token=", redact: "token=[redacted]", clearedContent: "token=", clearedFields: [], sentinel: [], empty: ["token"] },
  { name: "C27", input: "tok en=v", redact: "tok en=v", clearedContent: "tok en=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C28", input: "tok-en=v", redact: "tok-en=v", clearedContent: "tok-en=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C29", input: "monkey=v", redact: "monkey=v", clearedContent: "monkey=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C30", input: "=v", redact: "=v", clearedContent: "=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C31", input: " token=v", redact: " token=[redacted]", clearedContent: " token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C32", input: "token\u000b=v", redact: "token\u000b=v", clearedContent: "token\u000b=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C33", input: "token\f=v", redact: "token\f=v", clearedContent: "token\f=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C34", input: "token =v", redact: "token =v", clearedContent: "token =v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C35", input: "'token'=v", redact: "'token'=[redacted]", clearedContent: "'token'=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C36", input: "token ", redact: "token ", clearedContent: "token ", clearedFields: [], sentinel: [], empty: [] },
  { name: "C37", input: "token\"\"=v", redact: "token\"\"=v", clearedContent: "token\"\"=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C38", input: "\"token=v", redact: "\"token=[redacted]", clearedContent: "\"token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C39", input: "GET /a?token=1 HTTP/1.1", redact: "GET /a?token=[redacted]", clearedContent: "GET /a?token=1 HTTP/1.1", clearedFields: [], sentinel: [], empty: [] },
  { name: "C40", input: "Authorization: Bearer abc", redact: "Authorization: [redacted]", clearedContent: "Authorization: Bearer abc", clearedFields: [], sentinel: [], empty: [] },
  { name: "C41", input: "curl -H 'Authorization: Bearer abc' https://x", redact: "curl -H 'Authorization: [redacted]", clearedContent: "curl -H 'Authorization: Bearer abc' https://x", clearedFields: [], sentinel: [], empty: [] },
  { name: "C42", input: "Set-Cookie: sid=1; Path=/", redact: "Set-Cookie: [redacted]", clearedContent: "Set-Cookie: sid=1; Path=/", clearedFields: [], sentinel: [], empty: [] },
  { name: "C43", input: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", redact: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", clearedContent: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", clearedFields: [], sentinel: [], empty: [] },
  { name: "C44", input: "token=😀", redact: "token=[redacted]", clearedContent: "token=😀", clearedFields: [], sentinel: [], empty: [] },
  { name: "C45", input: "😀token=v", redact: "😀token=[redacted]", clearedContent: "😀token=v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C46", input: "token=\u0000v", redact: "token=[redacted]", clearedContent: "token=\u0000v", clearedFields: [], sentinel: [], empty: [] },
  { name: "C47", input: "a=1\ntoken=2\nb=3", redact: "a=1\ntoken=[redacted]\nb=3", clearedContent: "a=1\ntoken=2\nb=3", clearedFields: [], sentinel: [], empty: [] },
  { name: "C48", input: "token=1\r\nsecret=2", redact: "token=[redacted]\r\nsecret=[redacted]", clearedContent: "token=1\r\nsecret=2", clearedFields: [], sentinel: [], empty: [] },
  { name: "C49", input: "\"token\" : \"abc\"", redact: "\"token\" : [redacted]", clearedContent: "\"token\" : \"abc\"", clearedFields: [], sentinel: [], empty: [] },
  { name: "C50", input: "'token' :", redact: "'token' :[redacted]", clearedContent: "'token' :", clearedFields: [], sentinel: [], empty: ["token"] },
]

describe("D18 scan equivalence", () => {
  it("the fixtures still contain the code units they were written with", () => {
    // P6: assert the input before asserting the behaviour.
    expect(VT.charCodeAt(0)).toBe(11)
    expect(FF.charCodeAt(0)).toBe(12)
    expect(NBSP.charCodeAt(0)).toBe(160)
    expect(NUL.charCodeAt(0)).toBe(0)
    expect(ASTRAL.length).toBe(2)
    expect(ASTRAL.charCodeAt(0)).toBe(0xd83d)
    expect(BOUNDARY).toHaveLength(50)
    expect(new Set(BOUNDARY.map((c) => c.input)).size).toBe(50)
    // The delicate boundary rows must still hold the character they name.
    expect(BOUNDARY[31].input.charCodeAt(5)).toBe(11)
    expect(BOUNDARY[32].input.charCodeAt(5)).toBe(12)
    expect(BOUNDARY[33].input.charCodeAt(5)).toBe(160)
    expect(BOUNDARY[45].input.charCodeAt(6)).toBe(0)
  })

  // The name carries the reading on purpose: with `--reporter=verbose` the
  // corpus size is in the run's own output, so a "zero mismatches at depth 5"
  // claim can be checked against the line that produced it instead of being
  // taken on trust. Module load also prints the same figures (see the
  // console.info above), which covers a filtered run.
  it(`corpus provenance: depth ${DEPTH}, ${CORPUS.length} strings (levels ${CORPUS_LEVELS.join("/")})`, () => {
    // P12: every layer below reports a count over CORPUS. That sentence is
    // worth nothing unless something states how big CORPUS is and proves the
    // enumeration behind it actually ran, so this asserts the generator's own
    // record of what it walked. `CORPUS_LEVELS` has one entry per completed
    // depth, so a depth that never entered the loop cannot look like one that
    // finished -- which is the substitution finding I2 was about.
    expect(CORPUS_LEVELS).toHaveLength(DEPTH)
    CORPUS_LEVELS.forEach((count, index) => {
      expect(count, `level ${index + 1} is incomplete`).toBe(ALPHABET.length ** (index + 1))
    })
    expect(CORPUS).toHaveLength(EXHAUSTIVE_COUNT + FIXTURES.length + FUZZ_COUNT)

    // And pin the two totals this file and TECH 3.2 both quote by name. Unlike
    // the mismatch counts in EQ-2, corpus size is fully determined (fixed
    // alphabet, fixed fixture list, fixed seed and draw count), so pinning it
    // is a drift guard rather than a gate that can fail for the wrong reason:
    // add a fixture and this goes red until the quoted numbers are updated.
    if (DEPTH === 4) expect(CORPUS).toHaveLength(269952)
    if (DEPTH === 5) expect(CORPUS).toHaveLength(1318528)
  })

  it("EQ-0a oracle equals the shipped scanner, value for value", () => {
    // Unit: corpus strings. At depth 4 that is 69,905 exhaustive + 47 fixtures
    // + 200,000 fuzz = 269,952.
    expect(countMismatches((s) => oracle(s), firstSensitiveCut)).toBe(0)
  })

  it("EQ-0b the L0 comparison can see every field it claims to compare", () => {
    // The first draft of this layer compared the oracle to the module's OUTPUT
    // rather than its return value. That layer really ran and really reported
    // zero -- and was blind to `key`, because no consumer shows `key` unless
    // the tail of the line happens to equal the sentinel or the empty string.
    // So each compared field gets its own control that moves only it.
    const faithful = countMismatches((s) => oracle(s), firstSensitiveCut)
    const wrongKey = countMismatches((s) => oracle(s, "wrong-key"), firstSensitiveCut)
    const cutOff = countMismatches((s) => oracle(s, "cut-minus-one"), firstSensitiveCut)
    const noTest = countMismatches((s) => oracle(s, "no-sensitivity-test"), firstSensitiveCut)

    expect(faithful).toBe(0)
    expect(wrongKey).toBeGreaterThan(0)
    expect(cutOff).toBeGreaterThan(0)
    expect(noTest).toBeGreaterThan(0)
  })

  it("EQ-1 linear scanner matches the oracle on every corpus string", () => {
    expect(countMismatches(firstSensitiveCut, (s) => oracle(s))).toBe(0)
  })

  it("EQ-2 the differential harness catches known-broken variants", () => {
    // Counts are deliberately NOT written down: they move with the corpus size
    // and a hard-coded number here would be a gate that fails for the wrong
    // reason. What is asserted is the direction.
    const caught = (defect: ScanDefect) =>
      countMismatches((s) => variantScan(s, defect), (s) => oracle(s))

    expect(caught("none")).toBe(0)

    for (const defect of [
      "drop-hyphen-from-key-class",
      "cut-before-trailing-blanks",
      "jump-to-j-plus-2",
      "no-closing-quote",
      "no-blanks-before-separator",
      "key-includes-closing-quote",
      "require-leading-quote",
    ] as ScanDefect[]) {
      expect(caught(defect), `variant ${defect} should have been caught`).toBeGreaterThan(0)
    }
  })

  it("EQ-2b three variants are semantic no-ops, and their expected count is 0", () => {
    // These three are NOT gaps in the corpus. They are provably unobservable,
    // and the reasons are in the scanner's own comments. They are asserted
    // separately from the seven above precisely so that nobody reads "all
    // controls fired" off a table where three of them cannot.
    //
    //   skip-leading-quote  - a leading quote moves only where a match starts,
    //                         and this function reports where it ends.
    //   jump-to-j-plus-1    - line[j] is never a separator here, and a match
    //                         starting on a quote reports the same {key, cut}
    //                         as one starting on the key run after it.
    //   resume-at-key-start-plus-one
    //                       - any suffix of a non-sensitive key run is also
    //                         non-sensitive, so rescanning never changes the
    //                         verdict. This one IS observable on the clock:
    //                         its killer is PERF-2, not any assertion here.
    const caught = (defect: ScanDefect) =>
      countMismatches((s) => variantScan(s, defect), (s) => oracle(s))

    expect(caught("skip-leading-quote")).toBe(0)
    expect(caught("jump-to-j-plus-1")).toBe(0)
    expect(caught("resume-at-key-start-plus-one")).toBe(0)
  })

  it("EQ-3 character classes agree with the frozen regex classes", () => {
    let disagreements = 0

    for (let code = 0; code < 65536; code += 1) {
      const ch = String.fromCharCode(code)
      if (probeKey(ch) !== RX_KEY.test(ch)) disagreements += 1
      if (probeQuote(ch) !== RX_QUOTE.test(ch)) disagreements += 1
      if (probeBlank(ch) !== RX_BLANK.test(ch)) disagreements += 1
      if (probeSep(ch) !== RX_SEP.test(ch)) disagreements += 1
    }

    // Unit: (code unit, class) pairs, 65,536 x 4 of them.
    expect(disagreements).toBe(0)
  })

  it("EQ-4 classes are pairwise disjoint", () => {
    // This is the premise the whole equivalence argument stands on: because the
    // classes do not overlap, shortening a maximal key run can only re-offer a
    // key character where a quote, blank or separator is demanded, so the
    // regex's backtracking could never have found a match the linear pass
    // misses. If this goes red, the argument has lost its floor.
    let overlaps = 0

    for (let code = 0; code < 65536; code += 1) {
      const ch = String.fromCharCode(code)
      const memberships =
        Number(probeKey(ch)) + Number(probeQuote(ch)) + Number(probeBlank(ch)) + Number(probeSep(ch))
      if (memberships > 1) overlaps += 1
    }

    expect(overlaps).toBe(0)
  })
})

describe("D18 boundary table", () => {
  // Tuple form rather than `$name`: object interpolation renders the label as
  // "boundary 'C01'" with quotes, and a test name that reads differently from
  // the label it is keyed by makes the mutation ledger harder to check.
  it.each(BOUNDARY.map((boundary) => [boundary.name, boundary] as const))(
    "EQ-5 boundary %s",
    (_name, boundary) => {
      const cleared = clearSentinelBody("text", boundary.input)

      expect(redactBodyText("text", boundary.input)).toBe(boundary.redact)
      expect(cleared.content).toBe(boundary.clearedContent)
      expect(cleared.fields).toEqual(boundary.clearedFields)
      expect(sentinelBodyFields("text", boundary.input)).toEqual(boundary.sentinel)
      expect(emptyBodyFields("text", boundary.input)).toEqual(boundary.empty)
    },
  )
})

// ---------------------------------------------------------------------------
// Performance rungs (TECH 4). These read a wall clock, which is normally a
// mistake here -- a functional test with a 3.6x timeout margin was a
// load-dependent false red on main for weeks (D14). Two things make these
// different, and both are numbers rather than intentions:
//
//   1. they are dedicated rungs, not a timeout bolted onto a functional test;
//   2. the margin is two orders of magnitude or better, not 3.6x.
//
// Measured on the shipped module. Each reading is the first scan of its own
// fresh process -- one rung per process, because measuring both in sequence
// lets the second inherit the first's warmed-up scanner and reports a figure
// two to three times better than the truth.
//
// PASS SIDE, this implementer's own cold-process readings:
//
//   PERF-1  worst of 20 cold processes  2.833 ms vs 1000 ms budget  = 353x
//   PERF-2  worst of 48 cold processes  1.930 ms vs  500 ms budget  = 259x
//                            (best 1.147 ms = 436x, at loadavg ~4.6)
//                            (worst ever seen 3.056 ms at loadavg ~8.9 = 163x)
//   PERF-2  re-checked when the budget moved: 6 cold processes, worst median
//                            1.328 ms at loadavg ~6 = 376x
//
// PERF-2's budget was 200 ms as first written here and is 500 ms by an owner
// ruling of 2026-08-29 (TECH 4.3, recorded there as a controlled revision).
// The reason belongs next to the constant because every margin below depends
// on it: at 200 ms the worst reading this rung has ever produced -- 3.056 ms,
// on a box at loadavg ~8.9 -- left 65x, i.e. this file's claim of "two orders
// of magnitude" held only on a quiet machine. At 500 ms that same worst
// reading leaves 163x, so the claim is now unconditional.
//
// FAIL SIDE, same protocol:
//
//   PERF-1  the backtracking regex this replaced
//             44,558 ms  = 45x over 1000 ms   (this implementer)
//             31,388 ms  = 31x over 1000 ms   (implementation review, real
//                                              module, median)
//   PERF-2  resuming the scan at keyStart + 1 (K16)
//              9,261 ms  = 18.5x over 500 ms  (this implementer)
//              7,845.335 ms = 15.7x over 500 ms  (implementation review, real
//                          module, raw [7828.614, 7845.335, 7882.600])
//              8,314.590 ms = 16.6x over 500 ms  (re-run against this 500 ms
//                          budget, real module, raw [8314.590, 8312.315,
//                          8340.809], loadavg 4.86 -- the rung did go red, so
//                          raising the budget did not spend the killer)
//
// MEASUREMENT: worst pass-side reading 3.056 ms, lowest fail-side reading
// 7,845.335 ms -- a factor of ~2,570 between them, and the budget sits inside
// that gap with 163x of room below it and 15.7x above it.
// CONCLUSION: at 500 ms neither side can be crossed by load noise (observed
// amplification on this machine is 1.7-2.7x). PERF-2 is still the rung to
// revisit first if this ever flakes, and its 15.7x is the smallest number in
// this block -- raising the budget again spends that, not spare headroom.
//
// SINGLE-COPY WARNING (D18 R1 finding I1): the number below also appears in
// TECH 4.3, and nothing mechanically pins the two together -- specs/ is not in
// this repository, so no committed test can read it. The constant here is the
// one the gate actually runs; TECH 4.3 is the one that records why. Changing
// either without the other is the drift that produced this finding.
const PERF_1_BUDGET_MS = 1000
const PERF_2_BUDGET_MS = 500

// The value after the final separator in both rung inputs. The expected output
// is the input truncated to the cut plus the sentinel, and the cut lands right
// after that separator, so the sentinel replaces exactly this tail.
const RUNG_TAIL = "abc"

// A size at which the frozen oracle -- which IS the quadratic regex -- is still
// affordable to run. See the note in PERF-1 for why the full-size inputs are
// checked against a closed form instead.
const ORACLE_TIE_LENGTH = 2000

// base64url alphabet, and deliberately no ':' and no '=' anywhere in it
function pathologicalRun(length: number): string {
  const pool = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  let out = ""
  while (out.length < length) out += pool
  return out.slice(0, length)
}

function medianOfThree(run: () => void): { median: number; raw: number[] } {
  const raw: number[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now()
    run()
    raw.push(performance.now() - start)
  }
  const sorted = [...raw].sort((a, b) => a - b)
  return { median: sorted[1], raw }
}

/** The cut lands just after the last separator, so the tail is what goes. */
function expectedRungOutput(input: string): string {
  return input.slice(0, input.length - RUNG_TAIL.length) + REDACTION_SENTINEL
}

function reportOverBudget(rung: string, median: number, budget: number, raw: number[]): void {
  throw new Error(
    `${rung} median ${median.toFixed(3)} ms exceeded ${budget} ms; raw=[${raw
      .map((n) => n.toFixed(3))
      .join(", ")}] loadavg=${loadavg()
      .map((n) => n.toFixed(2))
      .join("/")}`,
  )
}

describe("D18 performance rungs", () => {
  // Both rung inputs append a real sensitive hit to the pathological body on
  // purpose. Without it the correct return is \`null\` and the correct output
  // equals the input -- so the anti-cheat assertion below would hold for a
  // \`return null\` body too, an assertion whose two sides are identical by
  // construction. Verified on the shipped module: the correct output ends with
  // the sentinel, while a \`return null\` variant leaves output === input and
  // is caught here.
  it(
    "PERF-1 a pathological line plus a real hit stays linear",
    { timeout: 120_000 },
    () => {
      const input = `${pathologicalRun(200000 - 10)}@token=abc`
      let output = ""
      const { median, raw } = medianOfThree(() => {
        output = redactBodyText("text", input)
      })

      // PERF-3, the anti-cheat side, asserted on the very same input the clock
      // was reading, so no shortcut can buy speed here.
      //
      // The expectation is a closed form rather than a live oracle run. The
      // oracle is the backtracking regex, and running it on this input costs
      // about 30 s -- measured, not guessed -- which would make the healthy
      // gate slower than the regression it exists to catch and would put a
      // quadratic scan inside the test that removes one. The tie to the oracle
      // is kept below at a size where the oracle is cheap, on the same shape.
      expect(output).not.toBe(input)
      expect(output).toBe(expectedRungOutput(input))
      expect(output.endsWith(REDACTION_SENTINEL)).toBe(true)

      const tie = `${pathologicalRun(ORACLE_TIE_LENGTH - 10)}@token=abc`
      expect(redactBodyText("text", tie)).toBe(oracleRedactText(tie))
      expect(expectedRungOutput(tie)).toBe(oracleRedactText(tie))

      if (median >= PERF_1_BUDGET_MS) {
        reportOverBudget("PERF-1", median, PERF_1_BUDGET_MS, raw)
      }
    },
  )

  it(
    "PERF-2 one huge non-sensitive match plus a real hit stays linear",
    { timeout: 120_000 },
    () => {
      const input = `${pathologicalRun(50000 - 12)}=1 token=abc`
      let output = ""
      const { median, raw } = medianOfThree(() => {
        output = redactBodyText("text", input)
      })

      expect(output).not.toBe(input)
      expect(output).toBe(expectedRungOutput(input))
      expect(output.endsWith(REDACTION_SENTINEL)).toBe(true)

      // This shape leaves the regex a separator to find early, so the oracle is
      // affordable on the full input here and is run on it directly.
      expect(output).toBe(oracleRedactText(input))

      if (median >= PERF_2_BUDGET_MS) {
        reportOverBudget("PERF-2", median, PERF_2_BUDGET_MS, raw)
      }
    },
  )
})
