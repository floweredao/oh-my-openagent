import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { GATEWAY_NOT_INSTALLED, gatewayDoctorLines, runGatewayCommand } from "../bin/lib/gateway.js"

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function sink(): { write: (text: string) => void; text: () => string } {
  let buffer = ""
  return { write: (text: string) => { buffer += text }, text: () => buffer }
}

function missingPackage(): Error {
  return Object.assign(new Error("Cannot find package '@oh-my-opencode/omo-gateway' from '/somewhere/bin/lib/gateway.js'"), {
    code: "ERR_MODULE_NOT_FOUND",
  })
}

function home(userConfig?: string): { HOME: string } {
  const root = tempRoot("omo-gateway-hook-home-")
  mkdirSync(join(root, ".omo"), { recursive: true })
  if (userConfig !== undefined) writeFileSync(join(root, ".omo", "omo.jsonc"), userConfig)
  return { HOME: root }
}

function packagedOmo(gatewayHostSource?: string): string {
  const app = tempRoot("omo-gateway-hook-app-")
  cpSync(join(SOURCE_ROOT, "bin"), join(app, "bin"), { recursive: true })
  write(app, "package.json", JSON.stringify({ name: "omo-ai", version: "1.2.3-test.0", type: "module" }))
  write(app, "drive.mjs", [
    'import { runGatewayCommand } from "./bin/lib/gateway.js"',
    "process.exitCode = await runGatewayCommand(process.argv.slice(2), { launch: ['omo-under-test', 'gateway', 'connect'] })",
  ].join("\n"))
  if (gatewayHostSource !== undefined) {
    const pkg = join("node_modules", "@oh-my-opencode", "omo-gateway")
    write(app, join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-opencode/omo-gateway", type: "module", exports: { "./host": { import: "./host.js" } } }))
    write(app, join(pkg, "host.js"), gatewayHostSource)
  }
  return app
}

function drive(app: string, args: string[], env: { HOME: string }): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(app, "drive.mjs"), ...args], {
    cwd: app,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: env.HOME, OMO_CODING_AGENT_DIR: join(env.HOME, ".omo", "agent") },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const FIXTURE_HOST = [
  "export const HOST_CONTRACT_VERSION = 1",
  "export async function runGatewayCommand(args, context) {",
  "  context.stdout.write(JSON.stringify({ args, agentDir: context.agentDir, home: context.home, launch: context.launch }) + '\\n')",
  "  return 7",
  "}",
  "export async function gatewayDoctorLines() { return [] }",
].join("\n")

describe("omo gateway resolves a separately installed package", () => {
  test("#given the package is not installed #when omo gateway runs #then it prints one line and exits 1", async () => {
    // given
    const stdout = sink()
    const stderr = sink()

    // when
    const code = await runGatewayCommand(["status"], { stdout, stderr, env: home(), importHost: async () => { throw missingPackage() } })

    // then
    expect(code).toBe(1)
    expect(stdout.text()).toBe("")
    expect(stderr.text()).toBe(`omo gateway: ${GATEWAY_NOT_INSTALLED}\n`)
    expect(stderr.text().split("\n").filter(Boolean)).toHaveLength(1)
  })

  test("#given a packaged omo without the package #when omo gateway runs for real #then the bare-name import misses and it prints the one line", () => {
    // given
    const app = packagedOmo()

    // when
    const result = drive(app, ["status"], home())

    // then
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(`omo gateway: ${GATEWAY_NOT_INSTALLED}\n`)
  })

  test("#given the package installed beside omo #when omo gateway runs for real #then its host entry is called with the argv and host facts", () => {
    // given
    const app = packagedOmo(FIXTURE_HOST)
    const env = home()

    // when
    const result = drive(app, ["connect", "--scope", "qa"], env)

    // then
    expect(result.status).toBe(7)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["connect", "--scope", "qa"],
      agentDir: join(env.HOME, ".omo", "agent"),
      home: env.HOME,
      launch: ["omo-under-test", "gateway", "connect"],
    })
  })

  test("#given an installed package on another host contract #when omo gateway runs #then it names both versions and exits 1", () => {
    // given
    const app = packagedOmo(FIXTURE_HOST.replace("HOST_CONTRACT_VERSION = 1", "HOST_CONTRACT_VERSION = 2"))

    // when
    const result = drive(app, ["status"], home())

    // then
    expect(result.status).toBe(1)
    expect(result.stderr).toBe("omo gateway: the installed gateway speaks host contract 2, this omo speaks 1\n")
  })

  test("#given a missing module inside an installed package #when loaded #then it is reported as broken, not as not installed", async () => {
    // given
    const stderr = sink()
    const inner = Object.assign(new Error("Cannot find package 'left-pad' from '/x/node_modules/@oh-my-opencode/omo-gateway/host.js'"), { code: "ERR_MODULE_NOT_FOUND" })

    // when
    const code = await runGatewayCommand(["status"], { stdout: sink(), stderr, env: home(), importHost: async () => { throw inner } })

    // then
    expect(code).toBe(1)
    expect(stderr.text()).toStartWith("omo gateway: cannot load @oh-my-opencode/omo-gateway/host: Cannot find package 'left-pad'")
  })
})

describe("omo doctor gateway rows", () => {
  const installedHost = (lines: string[]) => async () => ({
    HOST_CONTRACT_VERSION: 1,
    runGatewayCommand: async () => 0,
    gatewayDoctorLines: async () => lines,
  })

  test("#given no gateway section #when doctor asks #then there are no rows and the package is never imported", async () => {
    // given
    let imported = 0
    const importHost = async () => { imported += 1; throw missingPackage() }

    // when
    const withoutFile = await gatewayDoctorLines({ env: home(), importHost })
    const withOtherKeys = await gatewayDoctorLines({ env: home(JSON.stringify({ disabled_skills: ["x"], profiles: { p: { gateway: {} } } })), importHost })

    // then
    expect(withoutFile).toEqual([])
    expect(withOtherKeys).toEqual([])
    expect(imported).toBe(0)
  })

  test("#given a gateway section and no package #when doctor asks #then one WARN row says it is not installed", async () => {
    // given
    const env = home(`// user config\n{ "gateway": { "scopes": [{ "id": "qa" }] }, }`)

    // when
    const lines = await gatewayDoctorLines({ env, importHost: async () => { throw missingPackage() } })

    // then
    expect(lines).toEqual([`WARN gateway: ${GATEWAY_NOT_INSTALLED}`])
  })

  test("#given a gateway section in the [native] block and the package installed #when doctor asks #then the installed row is followed by the package's own rows", async () => {
    // given
    const env = home(JSON.stringify({ "[native]": { gateway: { scopes: [{ id: "qa" }] } } }))

    // when
    const lines = await gatewayDoctorLines({ env, importHost: installedHost(["PASS gateway config: valid (x)", "WARN gateway surface qa/slack: options not checked"]) })

    // then
    expect(lines).toEqual(["PASS gateway: installed", "PASS gateway config: valid (x)", "WARN gateway surface qa/slack: options not checked"])
  })

  test("#given a FAIL gateway row #when runDoctor finishes #then the process exits failing, and passes without it", () => {
    // given: a packaged install whose every other check passes
    const app = packagedOmo()
    const senpi = { "@code-yeongyu/senpi": "2026.8.9" }
    write(app, "package.json", JSON.stringify({ name: "omo-ai", version: "1.2.3-test.0", type: "module", dependencies: senpi }))
    write(app, "node_modules/@code-yeongyu/senpi/package.json", JSON.stringify({ name: "@code-yeongyu/senpi", version: "2026.8.9", type: "module", exports: { ".": "./dist/index.js" } }))
    for (const file of ["dist/index.js", "dist/cli.js", "dist/core/brand.js"]) write(app, `node_modules/@code-yeongyu/senpi/${file}`, "export {}\n")
    for (const file of ["plugin/package.json", "plugin/extensions/omo.js", "plugin/runtime/lsp-daemon/dist/cli.js"]) write(app, file, "fixture\n")
    write(app, "doctor.mjs", [
      'import { runDoctor } from "./bin/lib/doctor.js"',
      "runDoctor({ harnesses: [] }, [], { gateway: JSON.parse(process.argv[2]), fetchDistTags: () => ({}), list: () => [], listDirs: () => [], hasRepo: () => false })",
    ].join("\n"))
    const doctor = (gateway: string[]) => spawnSync(process.execPath, [join(app, "doctor.mjs"), JSON.stringify(gateway)], {
      encoding: "utf8",
      env: { ...process.env, OMO_CODING_AGENT_DIR: join(app, "agent") },
    })

    // when
    const control = doctor(["PASS gateway: installed"])
    const failing = doctor(["PASS gateway: installed", "FAIL gateway config: x"])

    // then
    expect(control.status).toBe(0)
    expect(failing.stdout).toContain("FAIL gateway config: x")
    expect(failing.status).toBe(1)
  })
})
