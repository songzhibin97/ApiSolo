// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"
import { mount, shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createI18n } from "vue-i18n"

import RequestPanel from "../panels/RequestPanel.vue"
import PendingRefillNotice from "../request/PendingRefillNotice.vue"
import { useTabsStore } from "../../stores/tabs"
import { pendingRefillFields, type PendingField, type PendingKind } from "../../utils/pending-refill"
import { REDACTION_SENTINEL } from "../../utils/redaction"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"
import type { AuthConfig, HistoryEntry } from "../../types"

/**
 * Why this file exists next to `RequestPanel.test.ts` and `SaveFromHistory.test.ts`
 * rather than inside them: both of those replace `useI18n` with `t: key => key`
 * for their whole module. Under that stub the rendered output is the message
 * key spelled out, so it is the same string whether the component ran the
 * fields through `formatPendingField` or picked a heading by class or not --
 * every assertion about what the user reads holds no matter what the components
 * do, and mutating the wiring leaves them green. Four such mutations were run
 * against the suite and all four survived.
 *
 * So this file installs the real messages and asserts the text that reaches the
 * screen. That is deliberately outside the usual component-test whitelist
 * (child props / `v-if` existence / `v-for` count / `disabled`): the notice
 * banner is rendered inline by `RequestPanel`, it has no child component to
 * read props off, and "which of the two sentences is showing" is only visible
 * as text. The pure functions underneath are tested as pure functions in
 * `pending-refill.test.ts`; what is load-bearing here is that the components
 * call them at all, and with which class.
 */
function i18nFor(locale: "en" | "zh-CN") {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages: { "zh-CN": zhCN, en },
  })
}

let pinia: ReturnType<typeof createPinia>

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h-w1",
    method: "POST",
    url: "https://api.example.com/users",
    status: 200,
    time: 10,
    size: 10,
    timestamp: "2026-03-27T10:00:00Z",
    contentType: "application/json",
    requestHeaders: [],
    requestParams: [],
    requestBodyType: "none",
    requestBodyFormData: [],
    ...overrides,
  } as HistoryEntry
}

/**
 * A body typed as JSON that the scanner cannot parse -- unquoted key -- with
 * the placeholder sitting bare after the colon so the text fallback clears it
 * and writes the name down. Reading it back is what cannot be done: the body
 * still will not parse, so nothing can say whether `token` was filled in again.
 */
const UNPARSEABLE_JSON_BODY = `{\n  token: ${REDACTION_SENTINEL}\n}`

describe("§8 §10 §11 §17 the standing notice tells the user which state the request is in", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function openAndMount(source: HistoryEntry, locale: "en" | "zh-CN") {
    const tabs = useTabsStore()
    tabs.openHistoryEntry(source)

    return {
      tabs,
      wrapper: shallowMount(RequestPanel, { global: { plugins: [pinia, i18nFor(locale)] } }),
    }
  }

  function kindsOf(tab: Parameters<typeof pendingRefillFields>[0]): PendingKind[] {
    return pendingRefillFields(tab).map((field) => field.kind)
  }

  // Mutating `formatPendingField(field, t)` to a bare `field.name` in the panel
  // leaves this history with a notice that names nothing at all: an auth slot
  // has no user-supplied name, so `name` is the empty string. That mutation is
  // invisible to a suite that only checks the banner exists.
  it.each([
    ["zh-CN", "认证 · Bearer 令牌"],
    ["en", "Auth · Bearer token"],
  ] as const)("%s names the blanked auth slot, not just its position", (locale, expected) => {
    const { tabs, wrapper } = openAndMount(
      entry({ requestAuth: { type: "bearer", bearer: { token: "" } } as AuthConfig }),
      locale,
    )

    // The fixture is only worth asserting against if it really is in the class
    // the test claims; a silent change of shape would otherwise read as a pass.
    expect(kindsOf(tabs.activeTab)).toEqual(["refill"])

    const refill = wrapper.find("[data-testid=\"history-redacted-banner-refill\"]")
    expect(refill.exists()).toBe(true)
    expect(refill.text()).toContain(expected)
    expect(wrapper.find("[data-testid=\"history-redacted-banner-unverifiable\"]").exists()).toBe(
      false,
    )
  })

  /**
   * §8. The user filled `token` back in and the notice stayed up, because
   * nothing can read an unparseable body -- so the notice has to say that, and
   * say how to make it go away. Under the old single sentence it said "these
   * need re-entering", which was both untrue and unactionable.
   */
  it.each([
    ["zh-CN", "请求体不是合法 JSON", "需要重新填写", "请求体 · token"],
    ["en", "not valid JSON", "must be re-entered", "Body · token"],
  ] as const)(
    "%s explains an unparseable body instead of listing it as re-fillable",
    (locale, explanation, refillWording, label) => {
      const { tabs, wrapper } = openAndMount(
        entry({ requestBodyType: "json", requestBodyContent: UNPARSEABLE_JSON_BODY }),
        locale,
      )

      expect(kindsOf(tabs.activeTab)).toEqual(["refill-unverifiable"])

      const unverifiable = wrapper.find("[data-testid=\"history-redacted-banner-unverifiable\"]")
      expect(unverifiable.exists()).toBe(true)
      expect(unverifiable.text()).toContain(explanation)
      // The names are still there. Which fields the sentence is about is not
      // something the user can work out from a count.
      expect(unverifiable.text()).toContain(label)

      // And the other sentence is not also showing. Saying both at once would
      // put the claim this state cannot support back on the screen.
      expect(wrapper.find("[data-testid=\"history-redacted-banner-refill\"]").exists()).toBe(false)
      expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").text()).not.toContain(
        refillWording,
      )
    },
  )

  /**
   * Both classes on one request. The spec says the two states get two different
   * sentences but does not say how they sit together when both apply, so this
   * is the implementation's answer: both sentences, each over its own fields,
   * neither one standing in for the other.
   */
  it("says both sentences when the request is in both states", () => {
    const { tabs, wrapper } = openAndMount(
      entry({
        requestBodyType: "json",
        requestBodyContent: UNPARSEABLE_JSON_BODY,
        requestAuth: { type: "bearer", bearer: { token: "" } } as AuthConfig,
      }),
      "zh-CN",
    )

    expect(kindsOf(tabs.activeTab).sort()).toEqual(["refill", "refill-unverifiable"])

    const refill = wrapper.find("[data-testid=\"history-redacted-banner-refill\"]")
    const unverifiable = wrapper.find("[data-testid=\"history-redacted-banner-unverifiable\"]")

    expect(refill.exists()).toBe(true)
    expect(unverifiable.exists()).toBe(true)

    // Each sentence covers its own class only. Running the two lists together
    // would put `token` under "needs re-entering", which is the claim §8 says
    // cannot be made about an unparseable body.
    expect(refill.text()).toContain("认证 · Bearer 令牌")
    expect(refill.text()).not.toContain("请求体 · token")
    expect(unverifiable.text()).toContain("请求体 · token")
    expect(unverifiable.text()).not.toContain("Bearer 令牌")
  })
})

describe("§8 §17 the save dialog's list keeps the classes apart on screen", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function mountNotice(fields: PendingField[], locale: "en" | "zh-CN") {
    return mount(PendingRefillNotice, {
      props: { fields },
      global: { plugins: [pinia, i18nFor(locale)] },
    })
  }

  const unverifiableBodyField: PendingField = {
    kind: "refill-unverifiable",
    source: "body",
    name: "token",
  }

  // Two mutations die here. Dropping the group hides the fields entirely;
  // pointing its heading at `history.refillTitle` puts them back under "these
  // must be re-entered", which is the sentence this class exists to avoid.
  it.each([
    ["zh-CN", "请求体不是合法 JSON", "需要重新填写"],
    ["en", "not valid JSON", "must be re-entered"],
  ] as const)("%s gives the unverifiable class its own heading", (locale, explanation, refillWording) => {
    const wrapper = mountNotice([unverifiableBodyField], locale)

    const group = wrapper.find("[data-testid=\"pending-group-unverifiable\"]")
    expect(group.exists()).toBe(true)
    expect(group.text()).toContain(explanation)
    expect(group.text()).not.toContain(refillWording)
    expect(wrapper.find("[data-testid=\"pending-group-refill\"]").exists()).toBe(false)
  })

  // Mutating the list item to render `field.name` costs the auth entry every
  // word it has and costs the body entry its source. Both stay listed, so a
  // count assertion cannot see it.
  it.each([
    ["zh-CN", ["认证 · Bearer 令牌", "请求体 · token"]],
    ["en", ["Auth · Bearer token", "Body · token"]],
  ] as const)("%s spells out where each pending field sits", (locale, expected) => {
    const wrapper = mountNotice(
      [
        { kind: "refill", source: "auth", slot: "bearer-token", name: "" },
        { kind: "refill", source: "body", name: "token" },
      ],
      locale,
    )

    const rows = wrapper.findAll("[data-testid=\"pending-group-refill\"] li").map((li) => li.text())

    expect(rows).toEqual(expected)
  })
})
