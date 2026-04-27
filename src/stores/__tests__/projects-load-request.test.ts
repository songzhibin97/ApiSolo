import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import { useProjectsStore } from "../projects"

describe("useProjectsStore.loadRequest", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
  })

  it("sanitizes legacy raw file paths from saved requests", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_request") {
        return {
          name: "Upload",
          method: "POST",
          url: "https://api.example.com/upload",
          params: [],
          headers: [],
          body: {
            type: "form-data",
            content: "",
            formData: [
              {
                id: "fd-1",
                enabled: true,
                key: "file",
                value: "",
                description: "",
                valueType: "file",
                fileName: "",
                filePath: "/tmp/legacy/hello.txt",
                fileContent: undefined,
                contentType: "text/plain",
              },
            ],
            binaryPath: "/tmp/legacy/payload.bin",
            binaryContent: undefined,
          },
          auth: { type: "none" },
          preRequestScript: "",
          testScript: "",
        }
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const store = useProjectsStore()
    store.activeProject = "demo"

    const request = await store.loadRequest("uploads/request.request.json")

    expect(request.body.binaryPath).toBe("payload.bin")
    expect(request.body.formData[0].fileName).toBe("hello.txt")
    expect(request.body.formData[0].filePath).toBe("")
  })
})
