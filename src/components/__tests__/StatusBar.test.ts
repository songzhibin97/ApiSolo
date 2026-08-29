// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createI18n } from "vue-i18n"

import StatusBar from "../layout/StatusBar.vue"
import { useConsoleStore } from "../../stores/console"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

function mountStatusBar(locale: "en" | "zh-CN", errorCount: number) {
  const consoleStore = useConsoleStore()
  consoleStore.entries = Array.from({ length: errorCount }, (_, index) => ({
    id: `error-${index}`,
    level: "error" as const,
    message: `error ${index}`,
    timestamp: `2026-08-30T00:00:${String(index).padStart(2, "0")}Z`,
    source: "app" as const,
  }))

  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages: { en, "zh-CN": zhCN },
  })

  return { consoleStore, wrapper: mount(StatusBar, { global: { plugins: [pinia, i18n] } }) }
}

describe("D22 console error badge layout", () => {
  it.each([
    { locale: "en" as const, count: 1, title: "Console" },
    { locale: "zh-CN" as const, count: 10, title: "控制台" },
  ])("keeps the icon, $count badge and $title in separate flow slots", ({ locale, count, title }) => {
    const { wrapper } = mountStatusBar(locale, count)
    const button = wrapper.get('[data-testid="console-toggle"]')
    const icon = button.get('[data-testid="console-icon"]')
    const badge = button.get('[data-testid="console-error-count"]')
    const titleNode = button.get('[data-testid="console-title"]')
    const children = Array.from(button.element.children)

    expect(badge.text()).toBe(String(count))
    expect(titleNode.text()).toBe(title)
    expect(children).toHaveLength(3)
    expect(children[0]).toBe(icon.element)
    expect(children[1]).toBe(badge.element)
    expect(children[2]).toBe(titleNode.element)
    expect(badge.classes()).not.toContain("absolute")
    expect(badge.classes().some((token) => token.startsWith("-right-"))).toBe(false)
  })

  it("still toggles the console from the status bar button", async () => {
    const { consoleStore, wrapper } = mountStatusBar("en", 1)

    expect(consoleStore.isOpen).toBe(false)
    await wrapper.get('[data-testid="console-toggle"]').trigger("click")
    expect(consoleStore.isOpen).toBe(true)
  })
})
