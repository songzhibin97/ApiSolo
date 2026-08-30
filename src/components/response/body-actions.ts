/**
 * Pure helpers behind the response body action bar.
 *
 * They sit next to the component rather than in `src/utils` because nothing
 * else produces a response body view. The split exists so the character count
 * and the file naming can be exercised on their edges without mounting, while
 * the component tests stay on the wiring (PROCESS.md P8).
 */

/**
 * The media type alone: everything before the first `;`, trimmed and
 * lowercased.
 *
 * Every decision about *what kind of thing* a response is has to read this
 * rather than the header. A `Content-Type` carries parameters, and a parameter
 * is free to spell a type name it has nothing to do with —
 * `text/plain; charset=json` and `text/html; profile=json` are a text and an
 * HTML body. Matching against the whole header lets that parameter outrank
 * what the server actually said, so the file is named `.json` and the view is
 * chosen for a type nobody claimed.
 */
export function responseMediaType(contentType: string) {
  return contentType.split(";")[0].trim().toLowerCase()
}

/**
 * Ordered, so `application/xhtml+xml` lands on `html` rather than `xml`, and
 * `application/vnd.api+json` on `json`. Matched as substrings because real
 * media types arrive with vendor trees and `+suffix` forms attached — but only
 * ever against the media type, never against the parameters after it.
 */
const EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ["json", "json"],
  ["html", "html"],
  ["xml", "xml"],
  ["csv", "csv"],
  ["javascript", "js"],
]

export function responseFileExtension(contentType: string) {
  const type = responseMediaType(contentType)

  return EXTENSIONS.find(([token]) => type.includes(token))?.[1] ?? "txt"
}

/**
 * Counts code points without materialising them: `[...body].length` is correct
 * but allocates one array element per character, and this runs on bodies
 * measured in megabytes.
 *
 * A code point is still not a grapheme cluster — a flag emoji or a combining
 * accent counts more than once — so no caller should present this number as
 * anything finer than "how long the text is".
 */
export function countCodePoints(value: string) {
  let count = 0

  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)

    // A high surrogate followed by a low one is one code point held in two
    // units. A lone surrogate is not paired off, and counts as itself.
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
      }
    }

    count += 1
  }

  return count
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

/**
 * Every character comes from the clock and from a fixed table — nothing the
 * server said reaches the file name, so a hostile content type cannot steer
 * where the download lands.
 */
export function responseFileName(contentType: string, at: Date) {
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`

  return `response-${stamp}.${responseFileExtension(contentType)}`
}
