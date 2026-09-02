// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createI18n } from "vue-i18n"

import JsonTreeView from "../response/JsonTreeView.vue"
import en from "../../i18n/en"

/**
 * D44 (PROCESS.md P8). `response.items` is the one counted sentence whose number
 * lives in the template rather than the catalog: the view renders
 * `${entries.length} ${t("response.items", entries.length)}`, so the locale
 * matrix can pin "item | items" and still not see the count go missing from the
 * call. Dropping it left the suite green. This mounts the view with the real
 * English catalog, collapsed so the label is on screen, and reads the label.
 * vue-i18n falls back to the first form when no count is given, so the row at
 * two is the one that catches a dropped argument; the row at one pins the
 * singular against a label that always says "items".
 */
function mountCollapsed(data: unknown) {
  return mount(JsonTreeView, {
    // depth 0 is not below an expand depth of 0, so the root starts collapsed.
    props: { data, defaultExpandDepth: 0 },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: "en",
          fallbackLocale: false as const,
          messages: { en },
        }),
      ],
    },
  })
}

function spanTexts(wrapper: ReturnType<typeof mountCollapsed>) {
  return wrapper.findAll("span").map((span) => span.text())
}

// PROCESS.md P12: prove the harness can say both words before trusting its
// silence. Phase 1 is a correct assertion that must pass; phase 2 is the same
// assertion made wrong, which must fail on the value rather than because the
// mount blew up.
describe("harness self-check", () => {
  it("phase 1 — a collapsed root shows its ellipsis", () => {
    expect(spanTexts(mountCollapsed(["a"]))).toContain("... ]")
  })

  it("phase 2 — the same assertion made wrong fails on the value", () => {
    const spans = spanTexts(mountCollapsed(["a"]))

    expect(() => expect(spans).toContain("a label nothing renders")).toThrow(
      /a label nothing renders/,
    )
  })
})

describe("D44 the collapsed count label agrees with its count", () => {
  it.each([
    [["a"], "1 item"],
    [["a", "b"], "2 items"],
  ])("%j is labelled \"%s\"", (data, expected) => {
    expect(spanTexts(mountCollapsed(data))).toContain(expected)
  })
})
