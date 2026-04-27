import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"

const processes = []
const devBridgeToken = process.env.APISOLO_DEV_BRIDGE_TOKEN || randomBytes(32).toString("hex")

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ...env,
    },
  })

  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      process.exitCode = code
    }

    if (signal) {
      process.exitCode = 1
    }

    shutdown()
  })

  processes.push({ name, child })
}

function shutdown() {
  for (const { child } of processes) {
    if (!child.killed) {
      child.kill("SIGTERM")
    }
  }
}

process.on("SIGINT", () => {
  shutdown()
  process.exit(130)
})

process.on("SIGTERM", () => {
  shutdown()
  process.exit(143)
})

start("dev-api", "cargo", [
  "run",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--features",
  "dev-bridge",
  "--example",
  "dev_server",
], {
  APISOLO_DEV_BRIDGE_TOKEN: devBridgeToken,
})
start("vite", "npm", ["run", "dev:web:client"], {
  VITE_APISOLO_DEV_BRIDGE_TOKEN: devBridgeToken,
})
