import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { canonicalAgentDir, runtimeHome } from "./agent-dir.js"
import { parseJsonc } from "./jsonc.js"

/**
 * omo ships no gateway code. `omo gateway` and the `omo doctor` gateway rows import a separately
 * installed package's host entry by name from omo's own install, lazily: only for `omo gateway`, or
 * for doctor when the user config has a `gateway` section. Without one, doctor output is unchanged.
 */

export const GATEWAY_PACKAGE = "@oh-my-opencode/omo-gateway"
export const GATEWAY_HOST_ENTRY = `${GATEWAY_PACKAGE}/host`
export const GATEWAY_HOST_CONTRACT_VERSION = 1
export const GATEWAY_NOT_INSTALLED = `the omo gateway is not installed: install the ${GATEWAY_PACKAGE} package where omo is installed (for a global omo, \`bun add -g <package>\`), then run \`omo doctor\``

const GATEWAY_KEY = "gateway"
const NATIVE_BLOCK_KEYS = ["[native]", "[senpi]"]

export async function loadGatewayHost(importHost = () => import(GATEWAY_HOST_ENTRY)) {
  let host
  try {
    host = await importHost()
  } catch (error) {
    if (isMissingPackage(error)) return { status: "missing" }
    return { status: "broken", reason: `cannot load ${GATEWAY_HOST_ENTRY}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (host?.HOST_CONTRACT_VERSION !== GATEWAY_HOST_CONTRACT_VERSION) {
    return {
      status: "broken",
      reason: `the installed gateway speaks host contract ${String(host?.HOST_CONTRACT_VERSION)}, this omo speaks ${GATEWAY_HOST_CONTRACT_VERSION}`,
    }
  }
  return { status: "installed", host }
}

// A missing module inside an installed package is broken, not missing.
function isMissingPackage(error) {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? error.code : undefined
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false
  if (!error.message.includes(`'${GATEWAY_PACKAGE}`) && !error.message.includes(`"${GATEWAY_PACKAGE}`)) return false
  // Bun also names the package when its exported host file is absent. Check the
  // package directory without resolving an entry that exports may hide or break.
  const searchPaths = createRequire(import.meta.url).resolve.paths(GATEWAY_PACKAGE) ?? []
  return !searchPaths.some((path) => existsSync(join(path, GATEWAY_PACKAGE)))
}

/** `omo gateway <args>`: the installed package runs it; without the package, one stderr line and exit 1. */
export async function runGatewayCommand(args, options = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd() } = options
  const loaded = await loadGatewayHost(options.importHost)
  if (loaded.status === "missing") {
    stderr.write(`omo gateway: ${GATEWAY_NOT_INSTALLED}\n`)
    return 1
  }
  if (loaded.status === "broken") {
    stderr.write(`omo gateway: ${loaded.reason}\n`)
    return 1
  }
  return loaded.host.runGatewayCommand(args, {
    stdout,
    stderr,
    env,
    cwd,
    agentDir: canonicalAgentDir(env),
    home: runtimeHome(env),
    launch: options.launch ?? [process.execPath, process.argv[1], "gateway", "connect"],
  })
}

function userConfigPath(env) {
  const dir = join(runtimeHome(env), ".omo")
  const jsonc = join(dir, "omo.jsonc")
  if (existsSync(jsonc)) return jsonc
  const json = join(dir, "omo.json")
  return existsSync(json) ? json : null
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function hasGatewaySection(env = process.env) {
  const path = userConfigPath(env)
  if (path === null) return false
  let document
  try {
    document = parseJsonc(readFileSync(path, "utf8"))
  } catch {
    return false
  }
  if (!isRecord(document)) return false
  if (Object.hasOwn(document, GATEWAY_KEY)) return true
  return NATIVE_BLOCK_KEYS.some((key) => isRecord(document[key]) && Object.hasOwn(document[key], GATEWAY_KEY))
}

/** No `gateway` section: no rows. Otherwise one installed/not-installed row; an installed package adds its own rows. */
export async function gatewayDoctorLines(options = {}) {
  const { env = process.env, cwd = process.cwd() } = options
  if (!hasGatewaySection(env)) return []
  const loaded = await loadGatewayHost(options.importHost)
  if (loaded.status === "missing") return [`WARN gateway: ${GATEWAY_NOT_INSTALLED}`]
  if (loaded.status === "broken") return [`FAIL gateway: ${loaded.reason}`]
  try {
    return ["PASS gateway: installed", ...(await loaded.host.gatewayDoctorLines({ env, cwd }))]
  } catch (error) {
    return ["PASS gateway: installed", `WARN gateway: the gateway's doctor rows failed: ${error instanceof Error ? error.message : String(error)}`]
  }
}
