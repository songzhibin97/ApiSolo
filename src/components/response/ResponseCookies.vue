<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

interface ParsedCookie {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  maxAge: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

const props = defineProps<{
  headers: [string, string][];
}>();

const { t } = useI18n();

const cookies = computed(() => {
  return props.headers
    .filter(([name]) => name.toLowerCase() === "set-cookie")
    .map(([, value], index) => parseCookie(value, index));
});

function parseCookie(setCookieHeader: string, index: number): ParsedCookie {
  const parts = setCookieHeader.split(";").map((segment) => segment.trim()).filter(Boolean);
  const [nameValue = "", ...attributes] = parts;
  const eqIndex = nameValue.indexOf("=");

  const name = eqIndex >= 0 ? nameValue.slice(0, eqIndex).trim() : nameValue.trim();
  const value = eqIndex >= 0 ? nameValue.slice(eqIndex + 1).trim() : "";

  const parsedCookie: ParsedCookie = {
    id: `${name || "cookie"}:${index}`,
    name,
    value,
    domain: "",
    path: "",
    expires: "",
    maxAge: "",
    httpOnly: false,
    secure: false,
    sameSite: "",
  };

  for (const attribute of attributes) {
    const separatorIndex = attribute.indexOf("=");
    const attributeName = (separatorIndex >= 0 ? attribute.slice(0, separatorIndex) : attribute)
      .trim()
      .toLowerCase();
    const attributeValue = separatorIndex >= 0 ? attribute.slice(separatorIndex + 1).trim() : "";

    switch (attributeName) {
      case "domain":
        parsedCookie.domain = attributeValue;
        break;
      case "path":
        parsedCookie.path = attributeValue;
        break;
      case "expires":
        parsedCookie.expires = attributeValue;
        break;
      case "max-age":
        parsedCookie.maxAge = attributeValue;
        break;
      case "httponly":
        parsedCookie.httpOnly = true;
        break;
      case "secure":
        parsedCookie.secure = true;
        break;
      case "samesite":
        parsedCookie.sameSite = attributeValue;
        break;
      default:
        break;
    }
  }

  return parsedCookie;
}

function buildFlags(cookie: ParsedCookie) {
  const flags: string[] = [];

  if (cookie.httpOnly) {
    flags.push("HttpOnly");
  }

  if (cookie.secure) {
    flags.push("Secure");
  }

  if (cookie.sameSite) {
    flags.push(`SameSite=${cookie.sameSite}`);
  }

  if (cookie.maxAge) {
    flags.push(`Max-Age=${cookie.maxAge}`);
  }

  return flags;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      v-if="cookies.length === 0"
      class="flex h-full items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_35%,transparent)] text-sm text-[var(--text-secondary)]"
    >
      {{ t("response.noCookies") }}
    </div>

    <div v-else class="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      <table class="min-w-full table-fixed border-collapse font-mono text-sm select-none">
        <thead class="sticky top-0 bg-[color-mix(in_srgb,var(--bg-primary)_92%,black)] text-left text-[var(--text-secondary)]">
          <tr>
            <th class="w-40 border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.cookieName") }}</th>
            <th class="w-72 border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.cookieValue") }}</th>
            <th class="w-44 border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.cookieDomain") }}</th>
            <th class="w-32 border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.cookiePath") }}</th>
            <th class="w-52 border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.cookieExpires") }}</th>
            <th class="border-b border-[var(--border)] px-4 py-3 font-medium">{{ t("response.cookieFlags") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cookie in cookies" :key="cookie.id">
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-primary)]">
              <div class="truncate" :title="cookie.name">
                <span class="select-text">{{ cookie.name || "-" }}</span>
              </div>
            </td>
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-secondary)]">
              <div class="truncate" :title="cookie.value">
                <span class="select-text">{{ cookie.value || "-" }}</span>
              </div>
            </td>
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-secondary)]">
              <div class="truncate" :title="cookie.domain">
                <span class="select-text">{{ cookie.domain || "-" }}</span>
              </div>
            </td>
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-secondary)]">
              <div class="truncate" :title="cookie.path">
                <span class="select-text">{{ cookie.path || "/" }}</span>
              </div>
            </td>
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-secondary)]">
              <div class="truncate" :title="cookie.expires || cookie.maxAge">
                <span class="select-text">{{ cookie.expires || cookie.maxAge || "-" }}</span>
              </div>
            </td>
            <td class="border-b border-[var(--border)] px-4 py-3 align-top text-[var(--text-secondary)]">
              <div v-if="buildFlags(cookie).length" class="flex flex-wrap gap-2">
                <span
                  v-for="flag in buildFlags(cookie)"
                  :key="flag"
                  class="rounded px-2 py-1 text-xs text-[var(--text-primary)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                >
                  {{ flag }}
                </span>
              </div>
              <span v-else class="select-text">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
