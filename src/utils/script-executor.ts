import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync"
import QUICKJS_WASM_URL from "@jitl/quickjs-wasmfile-release-sync/wasm?url"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core"

import type { ScriptResult } from "../types"
import { recordConsoleEntry } from "../stores/console"

interface ScriptContext {
  request: {
    method: string
    url: string
    headers: Array<{ key: string; value: string }>
    body: string
  }
  response?: {
    status: number
    statusText: string
    headers: [string, string][]
    body: string
    time: number
  }
  variables: Record<string, string>
}

interface ScriptLogEvent {
  level: "log" | "warn" | "error"
  message: string
}

interface ScriptWorkerResult extends ScriptResult {
  consoleEvents: ScriptLogEvent[]
}

const SCRIPT_TIMEOUT_MS = 1000
const SCRIPT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024
const SCRIPT_STACK_LIMIT_BYTES = 512 * 1024
const BROWSER_SANDBOX_VARIANT = newVariant(RELEASE_SYNC, {
  wasmLocation: QUICKJS_WASM_URL,
})
let quickJsModule: Promise<QuickJSWASMModule> | null = null

export type { ScriptContext }

export async function executeScript(
  code: string,
  context: ScriptContext,
): Promise<ScriptResult> {
  if (!code.trim()) {
    return {
      success: true,
      logs: [],
      errors: [],
      assertions: [],
      updatedVariables: undefined,
    }
  }

  const result = await executeInQuickJs(code, context)
  publishScriptEvents(result, code)

  return {
    success: result.success,
    logs: result.logs,
    errors: result.errors,
    assertions: result.assertions,
    updatedVariables: result.updatedVariables,
  }
}

async function executeInQuickJs(
  code: string,
  context: ScriptContext,
): Promise<ScriptWorkerResult> {
  const QuickJS = await getSandboxQuickJS()

  try {
    const result = QuickJS.evalCode(buildRunnerSource(code, context), {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + SCRIPT_TIMEOUT_MS),
      memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
      maxStackSizeBytes: SCRIPT_STACK_LIMIT_BYTES,
    }) as ScriptWorkerResult

    return normalizeScriptResult(result)
  } catch (error) {
    return {
      success: false,
      logs: [],
      errors: [toQuickJsErrorMessage(error)],
      assertions: [],
      updatedVariables: undefined,
      consoleEvents: [],
    }
  }
}

function getSandboxQuickJS() {
  const variant =
    typeof window === "undefined" ? RELEASE_SYNC : BROWSER_SANDBOX_VARIANT
  quickJsModule ??= newQuickJSWASMModuleFromVariant(variant)
  return quickJsModule
}

function buildRunnerSource(code: string, context: ScriptContext) {
  return `
(() => {
  const userCode = ${JSON.stringify(code)};
  const context = ${JSON.stringify(context)};

  function formatValue(value) {
    if (typeof value === "string") {
      return '"' + value + '"';
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function toErrorMessage(error) {
    return error && typeof error.message === "string" ? error.message : String(error);
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    const names = Object.getOwnPropertyNames(value);
    for (const name of names) {
      deepFreeze(value[name]);
    }
    return Object.freeze(value);
  }

  function freezeRequest(input) {
    return deepFreeze({
      method: input.request.method,
      url: input.request.url,
      headers: input.request.headers.map((header) => ({ ...header })),
      body: input.request.body,
    });
  }

  function freezeResponse(input) {
    if (!input.response) {
      return undefined;
    }

    return deepFreeze({
      status: input.response.status,
      statusText: input.response.statusText,
      headers: input.response.headers.map(([key, value]) => [key, value]),
      body: input.response.body,
      time: input.response.time,
    });
  }

  function createExpectation(value, response) {
    const assertStatus = (expected) => {
      if (!response) {
        throw new Error("Response is not available");
      }
      if (response.status !== expected) {
        throw new Error(\`Expected status \${expected}, received \${response.status}\`);
      }
    };

    const assertHeader = (name) => {
      if (!response) {
        throw new Error("Response is not available");
      }
      const normalizedName = String(name).toLowerCase();
      const exists = response.headers.some(([headerName]) => String(headerName).toLowerCase() === normalizedName);
      if (!exists) {
        throw new Error(\`Expected header "\${name}" to exist\`);
      }
    };

    const be = {};

    Object.defineProperty(be, "ok", {
      enumerable: true,
      get() {
        if (!response) {
          throw new Error("Response is not available");
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(\`Expected 2xx status, received \${response.status}\`);
        }
        return true;
      },
    });

    Object.defineProperty(be, "json", {
      enumerable: true,
      get() {
        const raw = typeof value === "string" ? value : response && response.body;
        if (typeof raw !== "string") {
          throw new Error("Expected a JSON string body");
        }
        try {
          JSON.parse(raw);
        } catch {
          throw new Error("Expected body to be valid JSON");
        }
        return true;
      },
    });

    return {
      to: {
        equal(expected) {
          if (value !== expected) {
            throw new Error(\`Expected \${formatValue(value)} to equal \${formatValue(expected)}\`);
          }
        },
        contain(expected) {
          if (typeof value !== "string" && !Array.isArray(value)) {
            throw new Error("Expected value to support contain()");
          }
          const passed = typeof value === "string" ? value.includes(expected) : value.includes(expected);
          if (!passed) {
            throw new Error(\`Expected \${formatValue(value)} to contain \${formatValue(expected)}\`);
          }
        },
        have: {
          status: assertStatus,
          header: assertHeader,
        },
        be,
      },
    };
  }

  function createExecutor(input) {
    const logs = [];
    const errors = [];
    const assertions = [];
    const updatedVariables = {};
    const consoleEvents = [];

    const consoleProxy = {
      log: (...args) => {
        const message = args.map((item) => (typeof item === "string" ? item : formatValue(item))).join(" ");
        logs.push(message);
        consoleEvents.push({ level: "log", message });
      },
      warn: (...args) => {
        const message = args.map((item) => (typeof item === "string" ? item : formatValue(item))).join(" ");
        logs.push("[warn] " + message);
        consoleEvents.push({ level: "warn", message });
      },
      error: (...args) => {
        const message = args.map((item) => (typeof item === "string" ? item : formatValue(item))).join(" ");
        logs.push("[error] " + message);
        consoleEvents.push({ level: "error", message });
      },
    };

    const pm = {
      request: freezeRequest(input),
      response: freezeResponse(input),
      environment: {
        get(key) {
          return updatedVariables[key] ?? input.variables[key];
        },
        set(key, value) {
          updatedVariables[key] = String(value);
        },
      },
      test(name, fn) {
        try {
          fn();
          assertions.push({ name: String(name), passed: true });
        } catch (error) {
          assertions.push({
            name: String(name),
            passed: false,
            message: toErrorMessage(error),
          });
        }
      },
      expect(value) {
        return createExpectation(value, input.response);
      },
    };

    return {
      pm: deepFreeze(pm),
      consoleProxy: Object.freeze(consoleProxy),
      errors,
      assertions,
      logs,
      updatedVariables,
      consoleEvents,
    };
  }

  function buildResult(state) {
    return {
      success: state.errors.length === 0 && state.assertions.every((assertion) => assertion.passed),
      logs: state.logs,
      errors: state.errors,
      assertions: state.assertions,
      updatedVariables: Object.keys(state.updatedVariables).length > 0 ? state.updatedVariables : undefined,
      consoleEvents: state.consoleEvents,
    };
  }

  const state = createExecutor(context);

  try {
    const runner = Function("pm", "console", '"use strict";\\n' + userCode);
    runner(state.pm, state.consoleProxy);
  } catch (error) {
    state.errors.push(toErrorMessage(error));
  }

  return buildResult(state);
})()
`
}

function normalizeScriptResult(value: ScriptWorkerResult): ScriptWorkerResult {
  return {
    success: Boolean(value?.success),
    logs: Array.isArray(value?.logs) ? value.logs.map(String) : [],
    errors: Array.isArray(value?.errors) ? value.errors.map(String) : [],
    assertions: Array.isArray(value?.assertions)
      ? value.assertions.map((assertion) => ({
          name: String(assertion.name),
          passed: Boolean(assertion.passed),
          message: assertion.message ? String(assertion.message) : undefined,
        }))
      : [],
    updatedVariables:
      value?.updatedVariables && typeof value.updatedVariables === "object"
        ? Object.fromEntries(
            Object.entries(value.updatedVariables).map(([key, nextValue]) => [
              key,
              String(nextValue),
            ]),
          )
        : undefined,
    consoleEvents: Array.isArray(value?.consoleEvents)
      ? value.consoleEvents
          .filter((event) => event.level === "log" || event.level === "warn" || event.level === "error")
          .map((event) => ({ level: event.level, message: String(event.message) }))
      : [],
  }
}

function toQuickJsErrorMessage(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    String((error as { message?: unknown }).message).includes("interrupted")
  ) {
    return "Script execution timed out"
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function publishScriptEvents(result: ScriptWorkerResult, code: string) {
  for (const event of result.consoleEvents) {
    recordConsoleEntry(event.level, `[script] ${event.message}`, "script")
  }

  for (const message of result.errors) {
    recordConsoleEntry("error", `[script] Execution failed: ${message}`, "script")
  }

  if (result.assertions.length > 0) {
    const passedCount = result.assertions.filter((assertion) => assertion.passed).length
    const failedCount = result.assertions.length - passedCount
    recordConsoleEntry(
      failedCount > 0 ? "warn" : "info",
      `[script] Assertions completed: ${passedCount} passed, ${failedCount} failed`,
      "script",
    )
  } else if (code.trim() && result.errors.length === 0) {
    recordConsoleEntry("info", "[script] Execution completed", "script")
  }
}
