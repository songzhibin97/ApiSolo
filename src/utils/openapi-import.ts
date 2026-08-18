import type { KeyValuePair, RequestBody, SavedRequest } from "../types"
import type { PostmanImportResult } from "./postman-import"
import { parse as parseYaml } from "yaml"

interface OpenApiSpec {
  openapi?: string
  info?: {
    title?: string
  }
  servers?: Array<{
    url?: string
  }>
  components?: {
    schemas?: Record<string, OpenApiSchema>
  }
  paths?: Record<string, OpenApiPathItem>
}

interface OpenApiPathItem {
  parameters?: OpenApiParameter[]
  [method: string]: OpenApiOperation[] | OpenApiOperation | OpenApiParameter[] | undefined
}

interface OpenApiOperation {
  summary?: string
  operationId?: string
  parameters?: OpenApiParameter[]
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema; example?: unknown }>
  }
}

interface OpenApiParameter {
  name?: string
  in?: "query" | "header" | "path" | "cookie"
  required?: boolean
  description?: string
  schema?: OpenApiSchema
  example?: unknown
}

interface OpenApiSchema {
  $ref?: string
  type?: string
  format?: string
  properties?: Record<string, OpenApiSchema>
  items?: OpenApiSchema
  enum?: unknown[]
  example?: unknown
  default?: unknown
  required?: string[]
  oneOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
  allOf?: OpenApiSchema[]
}

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options"])

export function parseOpenApiSpec(json: string): PostmanImportResult {
  const spec = parseYaml(json) as OpenApiSpec | null | undefined

  if (!spec || typeof spec !== "object" || !spec.openapi?.startsWith("3.")) {
    throw new Error("Invalid OpenAPI 3 specification")
  }

  const baseUrl = spec.servers?.[0]?.url?.trim() || ""
  const requests: PostmanImportResult["requests"] = []

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const pathParameters = Array.isArray(pathItem?.parameters) ? pathItem.parameters : []

    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) {
        continue
      }

      const parsedOperation = operation as OpenApiOperation
      const folderPath = deriveFolderPath(path)
      const requestName =
        parsedOperation.summary?.trim() ||
        parsedOperation.operationId?.trim() ||
        `${method.toUpperCase()} ${path}`

      requests.push({
        name: requestName,
        folderPath,
        request: buildRequest(
          requestName,
          method.toUpperCase(),
          `${baseUrl}${path}`,
          parsedOperation,
          pathParameters,
          spec,
        ),
      })
    }
  }

  return {
    name: spec.info?.title?.trim() || "Imported OpenAPI",
    requests,
  }
}

function buildRequest(
  name: string,
  method: string,
  url: string,
  operation: OpenApiOperation,
  inheritedParameters: OpenApiParameter[],
  spec: OpenApiSpec,
): SavedRequest {
  const parameters = mergeParameters(inheritedParameters, operation.parameters ?? [])
  const params: KeyValuePair[] = []
  const headers: KeyValuePair[] = []
  const pathParameters = new Map<string, string>()

  for (const parameter of parameters) {
    const exampleValue = stringifyExample(resolveParameterExample(parameter, spec))

    if (parameter.in === "path") {
      pathParameters.set(parameter.name ?? "", exampleValue || `{{${parameter.name ?? "pathParam"}}}`)
      continue
    }

    const pair = createPair({
      key: parameter.name ?? "",
      value: exampleValue,
      enabled: true,
      description: parameter.description ?? "",
    })

    if (parameter.in === "query") {
      params.push(pair)
      continue
    }

    if (parameter.in === "header") {
      headers.push(pair)
    }
  }

  const body = parseRequestBody(operation.requestBody, spec)
  if (body.type === "json" && !headers.some((header) => header.key.toLowerCase() === "content-type")) {
    headers.push(createPair({ key: "Content-Type", value: "application/json" }))
  }

  return {
    name,
    method: method as SavedRequest["method"],
    url: replacePathParameters(url, pathParameters),
    params,
    headers,
    body,
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
  }
}

function parseRequestBody(requestBody: OpenApiOperation["requestBody"] | undefined, spec: OpenApiSpec): RequestBody {
  const base: RequestBody = {
    type: "none",
    content: "",
    formData: [],
    binaryPath: "",
  }

  const content = requestBody?.content
  if (!content) {
    return base
  }

  const jsonContent = content["application/json"]
  if (jsonContent) {
    const example = jsonContent.example ?? generateSchemaExample(jsonContent.schema, spec)
    return {
      ...base,
      type: "json",
      content: JSON.stringify(example ?? {}, null, 2),
    }
  }

  const formContent = content["application/x-www-form-urlencoded"]
  const resolvedFormSchema = resolveSchemaRef(formContent?.schema, spec)
  if (resolvedFormSchema?.properties) {
    const pairs = Object.entries(resolvedFormSchema.properties).map(([key, schema]) =>
      createPair({
        key,
        value: stringifyExample(generateSchemaExample(schema, spec)),
      }),
    )

    return {
      ...base,
      type: "form-urlencoded",
      content: pairs.map((pair) => `${pair.key}=${pair.value}`).join("&"),
    }
  }

  const multipartContent = content["multipart/form-data"]
  const resolvedMultipartSchema = resolveSchemaRef(multipartContent?.schema, spec)
  if (resolvedMultipartSchema?.properties) {
    return {
      ...base,
      type: "form-data",
      formData: Object.entries(resolvedMultipartSchema.properties).map(([key, schema]) => {
        if (isBinarySchema(schema, spec)) {
          return {
            ...createPair({ key, value: "" }),
            valueType: "file" as const,
            fileName: "",
            filePath: "",
            fileContent: undefined,
            contentType: "",
          }
        }

        return {
          ...createPair({
            key,
            value: stringifyExample(generateSchemaExample(schema, spec)),
          }),
          valueType: "text" as const,
          fileName: "",
          filePath: "",
          fileContent: undefined,
          contentType: "",
        }
      }),
    }
  }

  const binaryContent = Object.entries(content).find(
    ([contentType, value]) =>
      isBinarySchema(value.schema, spec) ||
      contentType.includes("octet-stream") ||
      contentType.startsWith("image/") ||
      contentType.startsWith("audio/") ||
      contentType.startsWith("video/") ||
      contentType === "application/pdf",
  )
  if (binaryContent) {
    return {
      ...base,
      type: "binary",
      binaryPath: "",
    }
  }

  const fallbackContent = Object.values(content)[0]
  if (fallbackContent?.example !== undefined) {
    return {
      ...base,
      type: "raw",
      content: stringifyExample(fallbackContent.example),
    }
  }

  return base
}

const MAX_SCHEMA_DEPTH = 20

/**
 * `seenRefs` has to be threaded through this function, not just through
 * resolveSchemaRef: every structural keyword below re-enters ref resolution,
 * and a set created per resolveSchemaRef call only ever guards a bare
 * $ref -> $ref chain. A schema referring to itself through `properties` --
 * the ordinary shape of a tree or parent/child model -- would otherwise
 * recurse until the stack gives out and take the whole document with it.
 *
 * The depth cap is the backstop for cycles that carry no $ref at all: JSON
 * and YAML both go through the YAML parser, and YAML anchors can produce a
 * genuinely cyclic object graph that no ref set can see.
 */
function generateSchemaExample(
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec,
  seenRefs: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) {
    return null
  }

  const ref = schema?.$ref?.trim()
  if (ref && seenRefs.has(ref)) {
    return null
  }

  const nextSeen = ref ? new Set([...seenRefs, ref]) : seenRefs

  const resolvedSchema = resolveSchemaRef(schema, spec)
  if (!resolvedSchema) {
    return ""
  }

  schema = resolvedSchema
  if (!schema) {
    return ""
  }

  if (schema.example !== undefined) {
    return schema.example
  }

  if (schema.default !== undefined) {
    return schema.default
  }

  if (schema.enum?.length) {
    return schema.enum[0]
  }

  if (schema.oneOf?.length) {
    return generateSchemaExample(schema.oneOf[0], spec, nextSeen, depth + 1)
  }

  if (schema.anyOf?.length) {
    return generateSchemaExample(schema.anyOf[0], spec, nextSeen, depth + 1)
  }

  if (schema.allOf?.length) {
    return Object.assign(
      {},
      ...schema.allOf.map((item) => generateSchemaExample(item, spec, nextSeen, depth + 1)),
    )
  }

  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        generateSchemaExample(value, spec, nextSeen, depth + 1),
      ]),
    )
  }

  if (schema.type === "array") {
    return [generateSchemaExample(schema.items, spec, nextSeen, depth + 1)]
  }

  if (schema.type === "integer" || schema.type === "number") {
    return 0
  }

  if (schema.type === "boolean") {
    return true
  }

  return schema.format === "date-time" ? new Date(0).toISOString() : ""
}

function mergeParameters(
  inheritedParameters: OpenApiParameter[],
  operationParameters: OpenApiParameter[],
) {
  const merged = new Map<string, OpenApiParameter>()

  for (const parameter of inheritedParameters) {
    merged.set(parameterKey(parameter), parameter)
  }

  for (const parameter of operationParameters) {
    merged.set(parameterKey(parameter), parameter)
  }

  return [...merged.values()]
}

function parameterKey(parameter: OpenApiParameter) {
  return `${parameter.in ?? ""}:${parameter.name ?? ""}`
}

function resolveParameterExample(parameter: OpenApiParameter, spec: OpenApiSpec) {
  if (parameter.example !== undefined) {
    return parameter.example
  }

  return generateSchemaExample(parameter.schema, spec)
}

function deriveFolderPath(path: string) {
  const [firstSegment] = path.split("/").filter(Boolean)
  return firstSegment ?? ""
}

function stringifyExample(value: unknown) {
  if (value === undefined || value === null) {
    return ""
  }

  if (typeof value === "string") {
    return value
  }

  return JSON.stringify(value)
}

function isBinarySchema(schema: OpenApiSchema | undefined, spec: OpenApiSpec) {
  const resolvedSchema = resolveSchemaRef(schema, spec)
  return resolvedSchema?.type === "string" && (resolvedSchema.format === "binary" || resolvedSchema.format === "base64")
}

function resolveSchemaRef(
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec,
  seenRefs: Set<string> = new Set(),
): OpenApiSchema | undefined {
  if (!schema?.$ref) {
    return schema
  }

  const ref = schema.$ref.trim()
  if (!ref.startsWith("#/") || seenRefs.has(ref)) {
    return schema
  }

  const target = resolveLocalRef(spec, ref)
  if (!target || typeof target !== "object") {
    return schema
  }

  return resolveSchemaRef(target as OpenApiSchema, spec, new Set([...seenRefs, ref]))
}

function resolveLocalRef(root: unknown, ref: string) {
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))

  let current: unknown = root
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

function replacePathParameters(url: string, values: Map<string, string>) {
  let resolved = url

  for (const [key, value] of values.entries()) {
    if (!key) {
      continue
    }

    const replacement = value.startsWith("{{") ? value : encodeURIComponent(value)
    resolved = resolved.split(`{${key}}`).join(replacement)
  }

  return resolved
}

function createPair({
  key,
  value,
  enabled = true,
  description = "",
}: {
  key: string
  value: string
  enabled?: boolean
  description?: string
}): KeyValuePair {
  return {
    id: crypto.randomUUID(),
    enabled,
    key,
    value,
    description,
  }
}
