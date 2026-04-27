import { describe, expect, it } from "vitest"
import { executeScript } from "../script-executor"
import type { ScriptContext } from "../script-executor"

function makeContext(overrides: Partial<ScriptContext> = {}): ScriptContext {
  return {
    request: {
      method: "GET",
      url: "http://test",
      headers: [],
      body: "",
    },
    variables: {},
    ...overrides,
  }
}

describe("executeScript", () => {
  it("executes empty script without errors", async () => {
    const result = await executeScript("", makeContext())

    expect(result.success).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("captures console.log output", async () => {
    const result = await executeScript('console.log("hello")', makeContext())

    expect(result.logs).toContain("hello")
  })

  it("captures passing assertions", async () => {
    const result = await executeScript(
      'pm.test("always passes", () => { pm.expect(1).to.equal(1) })',
      makeContext(),
    )

    expect(result.assertions).toHaveLength(1)
    expect(result.assertions[0].passed).toBe(true)
    expect(result.assertions[0].name).toBe("always passes")
  })

  it("captures failing assertions", async () => {
    const result = await executeScript(
      'pm.test("should fail", () => { pm.expect(1).to.equal(2) })',
      makeContext(),
    )

    expect(result.success).toBe(false)
    expect(result.assertions[0].passed).toBe(false)
    expect(result.assertions[0].message).toContain("Expected 1 to equal 2")
  })

  it("supports environment variable get/set", async () => {
    const result = await executeScript(
      'pm.environment.set("token", pm.environment.get("baseUrl"))',
      makeContext({
        variables: { baseUrl: "http://localhost" },
      }),
    )

    expect(result.updatedVariables?.token).toBe("http://localhost")
  })

  it("accesses response in test scripts", async () => {
    const result = await executeScript(
      'pm.test("status ok", () => { pm.expect(pm.response?.status).to.equal(200) })',
      makeContext({
        response: {
          status: 200,
          statusText: "OK",
          headers: [],
          body: "{}",
          time: 100,
        },
      }),
    )

    expect(result.assertions[0].passed).toBe(true)
  })

  it("captures runtime errors", async () => {
    const result = await executeScript('throw new Error("oops")', makeContext())

    expect(result.success).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain("oops")
  })

  it("supports contain assertion", async () => {
    const result = await executeScript(
      'pm.test("contains", () => { pm.expect("hello world").to.contain("world") })',
      makeContext(),
    )

    expect(result.assertions[0].passed).toBe(true)
  })

  it("times out long-running scripts", async () => {
    const result = await executeScript("while(true){}", makeContext())

    expect(result.success).toBe(false)
    expect(result.errors).toContain("Script execution timed out")
  })

  it("does not expose the host global object through constructor escape", async () => {
    const result = await executeScript(
      `const root = console.constructor.constructor("return this")();
       console.log(typeof root.process, typeof root.fetch, typeof root.document);`,
      makeContext(),
    )

    expect(result.success).toBe(true)
    expect(result.logs).toContain("undefined undefined undefined")
  })
})
