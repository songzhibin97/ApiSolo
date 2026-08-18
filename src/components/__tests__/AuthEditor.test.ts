// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"

const t = vi.fn((key: string) => key)

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t }),
}))

import AuthEditor from "../request/AuthEditor.vue"
import type { AuthConfig } from "../../types"

function mountWith(addTo: "header" | "query") {
  t.mockClear()

  const modelValue: AuthConfig = {
    type: "api-key",
    apiKey: { key: "X-Api-Key", value: "SECRET123", addTo },
  }

  return shallowMount(AuthEditor, { props: { modelValue } })
}

/**
 * Asserts the call into the injected translator, not the text on screen: what
 * the DOM implementation renders is not what WebKit renders, so a text
 * assertion here would be a green light for something nobody verified. That the
 * sentence appears in Chinese in the real app is a manual checkpoint.
 */
describe("§6 the panel explains the hidden query api key in place", () => {
  it("asks for the explanation when the key goes into the query", () => {
    mountWith("query")

    expect(t).toHaveBeenCalledWith("auth.queryKeyHidden")
  })

  it("does not ask for it when the key goes into a header", () => {
    // A permanently visible explanation is as misleading as a missing one: it
    // would claim the address bar is hiding something it is not.
    mountWith("header")

    expect(t).not.toHaveBeenCalledWith("auth.queryKeyHidden")
  })
})
