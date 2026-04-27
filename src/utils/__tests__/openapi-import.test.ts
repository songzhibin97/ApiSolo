import { describe, expect, it } from "vitest"
import { parseOpenApiSpec } from "../openapi-import"

describe("parseOpenApiSpec", () => {
  it("parses paths and methods", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Test API" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/users": {
          get: { summary: "List users" },
          post: { summary: "Create user" },
        },
        "/posts": {
          get: { summary: "List posts" },
        },
      },
    })

    const result = parseOpenApiSpec(spec)

    expect(result.requests.length).toBe(3)
    expect(
      result.requests.find(
        (request) => request.request.method === "GET" && request.request.url.includes("/users"),
      ),
    ).toBeTruthy()
    expect(result.requests.find((request) => request.request.method === "POST")).toBeTruthy()
  })

  it("uses server URL as base", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "API" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: { "/users": { get: { summary: "Users" } } },
    })

    const result = parseOpenApiSpec(spec)

    expect(result.requests[0].request.url).toContain("api.example.com")
    expect(result.requests[0].request.url).toBe("https://api.example.com/v1/users")
  })

  it("parses YAML openapi specs", () => {
    const spec = `
openapi: 3.0.0
info:
  title: YAML API
servers:
  - url: https://api.example.com
paths:
  /users:
    get:
      summary: List users
`

    const result = parseOpenApiSpec(spec)

    expect(result.name).toBe("YAML API")
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0].request.method).toBe("GET")
    expect(result.requests[0].request.url).toBe("https://api.example.com/users")
  })

  it("materializes path parameters into a usable URL while keeping query params structured", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Path Params" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/teams/{teamId}/members/{memberId}": {
          parameters: [
            {
              name: "teamId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            summary: "Get member",
            parameters: [
              {
                name: "memberId",
                in: "path",
                required: true,
                schema: { type: "integer" },
                example: 42,
              },
              {
                name: "include",
                in: "query",
                schema: { type: "string" },
                example: "roles",
              },
            ],
          },
        },
      },
    })

    const result = parseOpenApiSpec(spec)

    expect(result.requests[0].request.url).toBe("https://api.example.com/teams/{{teamId}}/members/42")
    expect(result.requests[0].request.params).toHaveLength(1)
    expect(result.requests[0].request.params[0].key).toBe("include")
    expect(result.requests[0].request.params[0].value).toBe("roles")
  })

  it("preserves multipart file fields and binary request bodies using the app body model", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Binary Bodies" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/upload": {
          post: {
            summary: "Upload file",
            requestBody: {
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        "/avatar": {
          post: {
            summary: "Upload avatar",
            requestBody: {
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: {
                      avatar: { type: "string", format: "binary" },
                      note: { type: "string", example: "profile" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })

    const result = parseOpenApiSpec(spec)

    expect(result.requests[0].request.body.type).toBe("binary")
    expect(result.requests[0].request.body.binaryPath).toBe("")
    expect(result.requests[1].request.body.type).toBe("form-data")
    expect(result.requests[1].request.body.formData[0].key).toBe("avatar")
    expect(result.requests[1].request.body.formData[0].valueType).toBe("file")
    expect(result.requests[1].request.body.formData[0].filePath).toBe("")
    expect(result.requests[1].request.body.formData[1].key).toBe("note")
    expect(result.requests[1].request.body.formData[1].valueType).toBe("text")
    expect(result.requests[1].request.body.formData[1].value).toBe("profile")
  })

  it("resolves local component schema refs when generating request body examples", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Refs API" },
      servers: [{ url: "https://api.example.com" }],
      components: {
        schemas: {
          PetProfile: {
            type: "object",
            properties: {
              nickname: { type: "string", example: "milo" },
              age: { type: "integer", default: 3 },
            },
          },
          CreatePetRequest: {
            type: "object",
            properties: {
              name: { type: "string", example: "Milo" },
              profile: { $ref: "#/components/schemas/PetProfile" },
            },
          },
        },
      },
      paths: {
        "/pets": {
          post: {
            summary: "Create pet",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreatePetRequest" },
                },
              },
            },
          },
        },
      },
    })

    const result = parseOpenApiSpec(spec)

    expect(result.requests[0].request.body.type).toBe("json")
    expect(result.requests[0].request.body.content).toBe(
      JSON.stringify(
        {
          name: "Milo",
          profile: {
            nickname: "milo",
            age: 3,
          },
        },
        null,
        2,
      ),
    )
  })
})
