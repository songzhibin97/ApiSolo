import { defineStore } from "pinia";
import { ref } from "vue";

import i18n from "../i18n";
import type { Locale, ProxyConfig, SettingsState, ThemeMode, TlsConfig } from "../types";

const SETTINGS_KEY = "apisolo:settings";
const DEFAULT_SETTINGS: SettingsState = {
  theme: "dark",
  fontSize: 14,
  locale: "zh-CN",
  proxy: {
    enabled: false,
    type: "http",
    host: "",
    port: 7890,
    auth: {
      username: "",
      password: "",
    },
  },
  tls: {
    verifySsl: true,
  },
};

let mediaQuery: MediaQueryList | null = null;
let mediaQueryListener: (() => void) | null = null;

export const useSettingsStore = defineStore("settings", () => {
  const theme = ref<ThemeMode>(DEFAULT_SETTINGS.theme);
  const fontSize = ref(DEFAULT_SETTINGS.fontSize);
  const locale = ref<Locale>(DEFAULT_SETTINGS.locale);
  const proxy = ref<ProxyConfig>(cloneProxyConfig(DEFAULT_SETTINGS.proxy));
  const tls = ref<TlsConfig>({ ...DEFAULT_SETTINGS.tls });

  function applyTheme(nextTheme = theme.value) {
    if (typeof window === "undefined") {
      return;
    }

    detachSystemThemeListener();

    const resolvedTheme = nextTheme === "system" ? getSystemTheme() : nextTheme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.setProperty("color-scheme", resolvedTheme);

    if (nextTheme === "system") {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQueryListener = () => {
        const systemTheme = getSystemTheme();
        document.documentElement.dataset.theme = systemTheme;
        document.documentElement.style.setProperty("color-scheme", systemTheme);
      };
      mediaQuery.addEventListener("change", mediaQueryListener);
    }
  }

  function applyFontSize(nextFontSize = fontSize.value) {
    if (typeof document === "undefined") {
      return;
    }

    document.documentElement.style.setProperty("--app-font-size", `${nextFontSize}px`);
  }

  function applyLocale(nextLocale = locale.value) {
    i18n.global.locale.value = nextLocale;

    if (typeof document !== "undefined") {
      document.documentElement.lang = nextLocale;
    }
  }

  function saveSettings() {
    if (typeof window === "undefined") {
      return;
    }

    const persistedProxy = cloneProxyConfig(proxy.value);
    if (persistedProxy.auth) {
      persistedProxy.auth.password = "";
    }

    const payload: SettingsState = {
      theme: theme.value,
      fontSize: fontSize.value,
      locale: locale.value,
      proxy: persistedProxy,
      tls: { ...tls.value },
    };

    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
  }

  function loadSettings() {
    if (typeof window === "undefined") {
      return;
    }

    const rawValue = window.localStorage.getItem(SETTINGS_KEY);
    if (!rawValue) {
      applyTheme();
      applyFontSize();
      saveSettings();
      return;
    }

    try {
      const parsed = JSON.parse(rawValue) as Partial<SettingsState>;
      theme.value = isThemeMode(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme;
      fontSize.value =
        typeof parsed.fontSize === "number" && parsed.fontSize >= 12 && parsed.fontSize <= 20
          ? parsed.fontSize
          : DEFAULT_SETTINGS.fontSize;
      locale.value = isLocale(parsed.locale) ? parsed.locale : DEFAULT_SETTINGS.locale;
      proxy.value = sanitizeProxyConfig(parsed.proxy);
      tls.value = sanitizeTlsConfig(parsed.tls);
    } catch {
      theme.value = DEFAULT_SETTINGS.theme;
      fontSize.value = DEFAULT_SETTINGS.fontSize;
      locale.value = DEFAULT_SETTINGS.locale;
      proxy.value = cloneProxyConfig(DEFAULT_SETTINGS.proxy);
      tls.value = { ...DEFAULT_SETTINGS.tls };
    }

    applyTheme();
    applyFontSize();
    applyLocale();
    saveSettings();
  }

  function setTheme(nextTheme: ThemeMode) {
    theme.value = nextTheme;
    applyTheme(nextTheme);
    saveSettings();
  }

  function setFontSize(nextFontSize: number) {
    fontSize.value = Math.min(20, Math.max(12, Math.round(nextFontSize)));
    applyFontSize(fontSize.value);
    saveSettings();
  }

  function setLocale(nextLocale: Locale) {
    locale.value = nextLocale;
    applyLocale(nextLocale);
    saveSettings();
  }

  function setProxy(config: ProxyConfig) {
    proxy.value = sanitizeProxyConfig(config);
    saveSettings();
  }

  function setTls(config: TlsConfig) {
    tls.value = sanitizeTlsConfig(config);
    saveSettings();
  }

  loadSettings();

  return {
    theme,
    fontSize,
    locale,
    proxy,
    tls,
    setTheme,
    setFontSize,
    setLocale,
    setProxy,
    setTls,
    loadSettings,
    saveSettings,
  };
});

function getSystemTheme(): Exclude<ThemeMode, "system"> {
  if (typeof window === "undefined") {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function detachSystemThemeListener() {
  if (mediaQuery && mediaQueryListener) {
    mediaQuery.removeEventListener("change", mediaQueryListener);
  }

  mediaQuery = null;
  mediaQueryListener = null;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

function sanitizeProxyConfig(value: Partial<ProxyConfig> | null | undefined): ProxyConfig {
  const auth = value?.auth ?? DEFAULT_SETTINGS.proxy.auth;

  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.proxy.enabled,
    type: value?.type === "socks5" ? "socks5" : DEFAULT_SETTINGS.proxy.type,
    host: typeof value?.host === "string" ? value.host : DEFAULT_SETTINGS.proxy.host,
    port:
      typeof value?.port === "number" && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535
        ? value.port
        : DEFAULT_SETTINGS.proxy.port,
    auth: {
      username: typeof auth?.username === "string" ? auth.username : DEFAULT_SETTINGS.proxy.auth?.username ?? "",
      password: typeof auth?.password === "string" ? auth.password : DEFAULT_SETTINGS.proxy.auth?.password ?? "",
    },
  };
}

function sanitizeTlsConfig(value: Partial<TlsConfig> | null | undefined): TlsConfig {
  return {
    verifySsl: typeof value?.verifySsl === "boolean" ? value.verifySsl : DEFAULT_SETTINGS.tls.verifySsl,
  };
}

function cloneProxyConfig(config: ProxyConfig): ProxyConfig {
  return {
    ...config,
    auth: config.auth ? { ...config.auth } : undefined,
  };
}
