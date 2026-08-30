import { describe, expect, it } from "vitest"

import {
  countCodePoints,
  responseFileExtension,
  responseFileName,
  responseMediaType,
} from "../response/body-actions"

describe("countCodePoints", () => {
  // PROCESS.md P12: show the harness can say both words before trusting it.
  describe("harness self-check", () => {
    it("phase 1 — a correct assertion passes", () => {
      expect(countCodePoints("abc")).toBe(3)
    })

    it("phase 2 — the same assertion made wrong fails on the value", () => {
      const count = countCodePoints("abc")

      expect(() => expect(count).toBe(99)).toThrow()
    })
  })

  // The reference implementation, kept next to the fast one: every case below
  // must agree with it, so the hand-rolled surrogate walk cannot drift into
  // its own definition of "character".
  const reference = (value: string) => [...value].length

  it.each([
    ["", 0],
    ["abc", 3],
    ["中文", 2],
    ["😀", 1],
    ["a😀b", 3],
    ["😀😀", 2],
  ])("counts %o as %i code points", (value, expected) => {
    expect(countCodePoints(value)).toBe(expected)
    expect(countCodePoints(value)).toBe(reference(value))
  })

  /**
   * The registered gap, asserted rather than described: a code point is not a
   * grapheme cluster, so one visible letter can count more than once and the
   * copy must never promise otherwise.
   *
   * Built at runtime, not written as a literal. The first attempt wrote the
   * decomposed letter into the file and it came back precomposed — one code
   * point instead of two — so the row asserted the opposite of what it meant
   * to and failed. That is PROCESS.md P6: when the input can be reinterpreted
   * on its way to disk, the fixture has to be constructed rather than typed,
   * and checked before the behaviour is.
   */
  it("counts a combining accent as its own code point", () => {
    const decomposed = `e${String.fromCharCode(0x0301)}`

    // Fixture self-check first: prove this is the two-unit form, not the
    // precomposed letter that happens to render the same way.
    expect(decomposed.length).toBe(2)
    expect(decomposed).not.toBe(String.fromCharCode(0x00e9))

    expect(countCodePoints(decomposed)).toBe(2)
    expect(countCodePoints(decomposed)).toBe(reference(decomposed))
  })

  // What the count is for: UTF-16 length disagrees here, and it is the number
  // a plain `body.length` would put in front of the user.
  it("disagrees with string length exactly where the units are paired", () => {
    expect("😀".length).toBe(2)
    expect(countCodePoints("😀")).toBe(1)
  })

  // Malformed input must not walk off the end or swallow the next character.
  it("counts a lone high surrogate as itself", () => {
    const lone = String.fromCharCode(0xd83d)

    expect(countCodePoints(lone)).toBe(1)
    expect(countCodePoints(`${lone}a`)).toBe(2)
  })

  it("counts a lone low surrogate as itself", () => {
    const lone = String.fromCharCode(0xde00)

    expect(countCodePoints(`a${lone}`)).toBe(2)
  })
})

describe("responseFileExtension", () => {
  it.each([
    ["application/json", "json"],
    ["application/json; charset=utf-8", "json"],
    ["application/vnd.api+json", "json"],
    ["text/html", "html"],
    ["application/xhtml+xml", "html"],
    ["text/xml", "xml"],
    ["text/csv", "csv"],
    ["application/javascript", "js"],
    ["text/plain", "txt"],
    ["application/octet-stream", "txt"],
    ["", "txt"],
  ])("maps %s to .%s", (contentType, expected) => {
    expect(responseFileExtension(contentType)).toBe(expected)
  })

  it("reads the content type without regard to case", () => {
    expect(responseFileExtension("APPLICATION/JSON")).toBe("json")
  })

  /**
   * A parameter is not the type. `charset=json` and `profile=json` say nothing
   * about what the body is, and the file name is a claim about what the file
   * contains — naming a plain text response `.json` because of a parameter is
   * the interface stating something the server never said.
   *
   * The pair matters more than either row: the same token has to be honoured
   * where the server put it and ignored where it did not, or the fix is just
   * "stop recognising json".
   */
  it.each([
    ["text/plain; charset=json", "txt"],
    ["text/html; profile=json", "html"],
    ["application/octet-stream; name=report.csv", "txt"],
    ["text/plain;charset=utf-8", "txt"],
    ["  application/json  ; charset=utf-8", "json"],
  ])("takes %s as .%s, reading the media type and not its parameters", (contentType, expected) => {
    expect(responseFileExtension(contentType)).toBe(expected)
  })
})

describe("responseMediaType", () => {
  it.each([
    ["application/json", "application/json"],
    ["application/json; charset=utf-8", "application/json"],
    ["TEXT/HTML ;profile=json", "text/html"],
    ["", ""],
  ])("reads %o as %o", (contentType, expected) => {
    expect(responseMediaType(contentType)).toBe(expected)
  })
})

describe("responseFileName", () => {
  it("stamps the local clock and takes the extension from the content type", () => {
    const at = new Date(2026, 7, 30, 9, 5, 4)

    expect(responseFileName("application/json", at)).toBe("response-20260830-090504.json")
  })

  // Nothing the server said reaches the name, so a content type carrying path
  // separators or a second extension cannot steer where the download lands.
  it("never lets the content type into the file name itself", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5)

    expect(responseFileName("../../etc/passwd; charset=x", at)).toBe("response-20260102-030405.txt")
  })
})
