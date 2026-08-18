import { describe, expect, it } from "vitest"

import {
  buildUrlWithParams,
  splitUrlParts,
  stripQueryFromUrl,
  syncParamsFromUrl,
} from "../url-params"
import type { KeyValuePair } from "../../types"

const BASE = "https://api.example.com/items"

function pair(key: string, value: string, enabled = true): KeyValuePair {
  return { id: `${key}-${value}`, enabled, key, value, description: "" }
}

describe("§26 the url bar query matches the wire query", () => {
  // `expectedWireQuery` is written out by hand from what Rust puts on the wire:
  // `execute_request` appends every param with `item.enabled && !item.key.trim().is_empty()`
  // (src-tauri/src/lib.rs, `url.query_pairs_mut()`).
  it.each([
    [
      "a history entry carrying requestParams",
      [pair("a", "1"), pair("b", "2")],
      "a=1&b=2",
    ],
    [
      "params derived from the url",
      syncParamsFromUrl(`${BASE}?a=1&b=2`, []).params,
      "a=1&b=2",
    ],
    ["a repeated key", [pair("q", "1"), pair("q", "2")], "q=1&q=2"],
    ["a disabled param", [pair("a", "1"), pair("b", "2", false)], "a=1"],
  ])("url bar query matches the wire query for %s", (_name, params, expectedWireQuery) => {
    expect(buildUrlWithParams(BASE, params)).toBe(`${BASE}?${expectedWireQuery}`)
  })

  it("drops the query when nothing is enabled", () => {
    expect(buildUrlWithParams(BASE, [pair("a", "1", false)])).toBe(BASE)
  })
})

describe("url part helpers", () => {
  it("splits base url, query and fragment", () => {
    expect(splitUrlParts("https://api.example.com/items?a=1#frag")).toEqual({
      baseUrl: "https://api.example.com/items",
      hash: "#frag",
    })
    expect(splitUrlParts("/items")).toEqual({ baseUrl: "/items", hash: "" })
  })

  it("keeps the fragment out of the wire url", () => {
    expect(buildUrlWithParams(`${BASE}#frag`, [pair("a", "1")])).toBe(`${BASE}?a=1#frag`)
    expect(stripQueryFromUrl(`${BASE}?a=1`)).toBe(BASE)
  })

  it("moves the query into params and keeps disabled rows", () => {
    const synced = syncParamsFromUrl(`${BASE}?a=1`, [pair("b", "2", false)])

    expect(synced.url).toBe(BASE)
    expect(synced.params.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
      { key: "a", value: "1", enabled: true },
      { key: "b", value: "2", enabled: false },
    ])
  })
})
