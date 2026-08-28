// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createI18n } from "vue-i18n"

import AppHeader from "../layout/AppHeader.vue"
import StatusBar from "../layout/StatusBar.vue"
import SettingsModal from "../settings/SettingsModal.vue"
import { useUIStore } from "../../stores/ui"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"

/**
 * D19: the header, the status bar and the about panel each hardcoded "v0.1.0",
 * so the 0.2.0 build introduced itself as 0.1.0 on every surface at once. The
 * fix routes all three through __APP_VERSION__, injected by the define blocks
 * in vite.config.ts / vitest.config.ts from package.json. What is load-bearing
 * here is the whole chain: package.json -> define -> component -> rendered
 * text. The expected value is re-read from package.json with node:fs, not
 * taken from __APP_VERSION__, so a broken or missing define fails these tests
 * instead of cancelling out of the comparison. Real locale messages are
 * installed (not a `t: key => key` stub) for the same reason the repository's
 * PendingRefillWording tests do it: these assertions are about what the user
 * reads.
 */
function manifestVersion(): string {
  return JSON.parse(readFileSync("package.json", "utf8")).version
}

/**
 * Fresh regex per call — module-level /g regexes carry lastIndex state. No
 * word boundary on either side: wrapper.text() joins adjacent text nodes
 * without a separator ("ApiSolo" + "v0.2.0" becomes "ApiSolov0.2.0", and a
 * planted "v0.1.0" followed by the wired span becomes "v0.1.0v0.2.0"), so a
 * boundary on either flank silently stops matching exactly the strings this
 * scan exists to find. Verified against the concatenated form: both halves
 * of "v0.1.0v0.2.0" must surface.
 */
function versionShaped(text: string): string[] {
  return text.match(/v\d+\.\d+\.\d+/g) ?? []
}

function i18nInstance() {
  return createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en",
    messages: { "zh-CN": zhCN, en },
  })
}

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

describe("D19 the version the manifests agree on", () => {
  it("package.json carries a dotted-triple version, not garbage", () => {
    // Fail-closed: if the read or the key went wrong, "vundefined" comparisons
    // below could never pass, but this names the real culprit first.
    expect(manifestVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("tauri.conf.json ships the same version", () => {
    // The macOS bundle self-reports this file's version; if it drifts from
    // package.json the interface tells a different number than the bundle.
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
    expect(conf.version).toBe(manifestVersion())
  })

  it("Cargo.toml ships the same version", () => {
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8")
    const match = cargo.match(/^version = "([^"]+)"$/m)
    expect(match, "no package version line in Cargo.toml").not.toBeNull()
    expect(match![1]).toBe(manifestVersion())
  })
})

describe("D19 every surface renders the package.json version", () => {
  it("the text scan surfaces both halves of a concatenated pair", () => {
    // Fail-closed: a scan that cannot see a version string glued to its
    // neighbour by wrapper.text() would report the surfaces below as clean.
    expect(versionShaped("ApiSolov0.1.0v0.2.0")).toEqual(["v0.1.0", "v0.2.0"])
  })

  function globalConfig() {
    return {
      plugins: [pinia, i18nInstance()],
      stubs: { teleport: true },
    }
  }

  it("the header introduces the app as v<package.json version>", () => {
    const wrapper = mount(AppHeader, { global: globalConfig() })
    expect(wrapper.get('[data-testid="app-version"]').text()).toBe(`v${manifestVersion()}`)
    expect(versionShaped(wrapper.text())).toEqual([`v${manifestVersion()}`])
  })

  it("the status bar shows v<package.json version>", () => {
    const wrapper = mount(StatusBar, { global: globalConfig() })
    expect(wrapper.get('[data-testid="app-version"]').text()).toBe(`v${manifestVersion()}`)
    expect(versionShaped(wrapper.text())).toEqual([`v${manifestVersion()}`])
  })

  it("the about panel shows v<package.json version>", () => {
    useUIStore().openSettings()
    const wrapper = mount(SettingsModal, { global: globalConfig() })
    expect(wrapper.get('[data-testid="app-version"]').text()).toBe(`v${manifestVersion()}`)
    expect(versionShaped(wrapper.text())).toEqual([`v${manifestVersion()}`])
  })
})
