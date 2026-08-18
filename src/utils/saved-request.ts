import type { KeyValuePair, RequestBody, SavedRequest, Tab } from "../types"

function sanitizeFileLabel(value: string) {
  if (!value) {
    return ""
  }

  return value.split(/[\\/]/).pop() ?? value
}

/**
 * `id` is a per-session row handle and `redacted` is the in-memory
 * "needs re-entering" marker; neither belongs in a persisted request.
 */
export function stripTransientFields<T extends KeyValuePair>(items: T[]): T[] {
  return items.map(({ id: _id, redacted: _redacted, ...item }) => ({
    id: "",
    ...item,
  })) as T[]
}

export function sanitizeBodyForSave(body: RequestBody): RequestBody {
  if (body.type === "form-data") {
    return {
      type: "form-data",
      content: "",
      formData: stripTransientFields(body.formData).map((item) =>
        item.valueType === "file"
          ? {
              ...item,
              fileName: sanitizeFileLabel(item.fileName || item.filePath || item.key),
              filePath: "",
              fileContent: undefined,
            }
          : item,
      ),
      binaryPath: "",
      binaryContent: "",
    }
  }

  if (body.type === "binary") {
    return {
      type: "binary",
      content: "",
      formData: [],
      binaryPath: sanitizeFileLabel(body.binaryPath),
      binaryContent: undefined,
    }
  }

  if (body.type === "none") {
    return {
      type: "none",
      content: "",
      formData: [],
      binaryPath: "",
      binaryContent: undefined,
    }
  }

  return {
    type: body.type,
    content: body.content,
    formData: [],
    binaryPath: "",
    binaryContent: undefined,
  }
}

export function buildSavedRequest(tab: Tab, name: string): SavedRequest {
  return {
    name: name.trim(),
    method: tab.method,
    url: tab.url,
    params: stripTransientFields(tab.params),
    headers: stripTransientFields(tab.headers),
    body: sanitizeBodyForSave(tab.body),
    auth: {
      type: tab.auth.type,
      basic: tab.auth.basic,
      bearer: tab.auth.bearer,
      apiKey: tab.auth.apiKey,
    },
    preRequestScript: tab.preRequestScript,
    testScript: tab.testScript,
  }
}
