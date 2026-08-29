import { describe, expect, it } from "vitest"

import {
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

/**
 * Depth 4 is the committed size (269,952 strings, well under a second). Depth 5
 * is 1,318,528 and is what a reviewer runs by hand:
 *
 *   D18_SCAN_DEPTH=5 npx vitest run redaction-scan-equivalence
 *
 * Only an environment variable is read; no product-side switch exists.
 */
const DEPTH = Number(process.env.D18_SCAN_DEPTH ?? "4")

function buildCorpus(depth: number): string[] {
  const out: string[] = [""]
  let frontier: string[] = [""]

  for (let d = 1; d <= depth; d += 1) {
    const next: string[] = []
    for (const prefix of frontier) {
      for (const symbol of ALPHABET) {
        const s = prefix + symbol
        next.push(s)
        out.push(s)
      }
    }
    frontier = next
  }

  for (const fixture of FIXTURES) out.push(fixture)

  const random = mulberry32(FUZZ_SEED)
  for (let n = 0; n < FUZZ_COUNT; n += 1) {
    const length = 1 + Math.floor(random() * 12)
    let s = ""
    for (let k = 0; k < length; k += 1) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
    out.push(s)
  }

  return out
}

const CORPUS = buildCorpus(DEPTH)

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
  it.each(BOUNDARY)("EQ-5 boundary $name", (boundary) => {
    const cleared = clearSentinelBody("text", boundary.input)

    expect(redactBodyText("text", boundary.input)).toBe(boundary.redact)
    expect(cleared.content).toBe(boundary.clearedContent)
    expect(cleared.fields).toEqual(boundary.clearedFields)
    expect(sentinelBodyFields("text", boundary.input)).toEqual(boundary.sentinel)
    expect(emptyBodyFields("text", boundary.input)).toEqual(boundary.empty)
  })
})
