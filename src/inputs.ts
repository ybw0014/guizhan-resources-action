import * as core from "@actions/core"
import { readFile } from "node:fs/promises"

const defaultApiBaseUrl = "https://resources.guizhanss.com/api"
const urlSafeRegex = /^[a-zA-Z0-9!@$()`.+,_"-]*$/

export type ActionInputs = {
  apiBaseUrl: string
  token: string
  projectId: string
  channel: string
  files: string[]
  artifactNames: string[]
  primaryFile?: string
  version: string
  name: string
  changelog?: string
  changelogFile?: string
  minecraftVersions?: string[]
  platforms?: string[]
  dependencies?: unknown[]
  autoDetectMinecraft: boolean
  autoDetectPlatform: boolean
  retryAttempts: number
  retryDelayMs: number
  failMode: FailMode
}

export type FailMode = "fail" | "warn" | "skip"

export async function parseInputs(): Promise<ActionInputs> {
  const token = readRequiredInput("token")
  core.setSecret(token)

  const apiBaseUrl = normalizeApiBaseUrl(readOptionalInput("domain") ?? defaultApiBaseUrl)
  const projectId = readRequiredInput("project")
  const channel = readRequiredInput("channel")
  const files = parseListInput(readOptionalInput("files"))
  const artifactNames = parseListInput(readOptionalInput("artifact-names"))

  if (!files.length && !artifactNames.length) {
    throw new Error('At least one of "files" or "artifact-names" is required.')
  }

  const version = resolveVersion(readOptionalInput("version"))
  const name = readOptionalInput("name") ?? version
  if (!name) {
    throw new Error('Input "name" is required.')
  }

  const changelog = readOptionalInput("changelog")
  const changelogFile = readOptionalInput("changelog-file")
  if (changelog && changelogFile) {
    throw new Error('Only one of "changelog" or "changelog-file" may be set.')
  }
  const minecraftVersions = parseListInput(readOptionalInput("minecraft-versions"))
  const platforms = parseListInput(readOptionalInput("platforms"))
  const dependencies = parseDependencies(readOptionalInput("dependencies"))
  const primaryFile = readOptionalInput("primary-file")
  const autoDetectMinecraft = parseBooleanInput("auto-detect-minecraft", true)
  const autoDetectPlatform = parseBooleanInput("auto-detect-platform", true)
  const retryAttempts = parseIntegerInput("retry-attempts", 2, 1)
  const retryDelayMs = parseIntegerInput("retry-delay", 1000, 0)
  const failMode = parseFailMode(readOptionalInput("fail-mode"))

  const inputs: ActionInputs = {
    apiBaseUrl,
    token,
    projectId,
    channel,
    files,
    artifactNames,
    version,
    name,
    autoDetectMinecraft,
    autoDetectPlatform,
    retryAttempts,
    retryDelayMs,
    failMode,
  }

  if (primaryFile) {
    inputs.primaryFile = primaryFile
  }

  if (changelogFile) {
    inputs.changelogFile = changelogFile
    inputs.changelog = await readChangelogFile(changelogFile)
  } else if (changelog) {
    inputs.changelog = changelog
  }

  if (minecraftVersions.length) {
    inputs.minecraftVersions = minecraftVersions
  }

  if (platforms.length) {
    inputs.platforms = platforms
  }

  if (dependencies) {
    inputs.dependencies = dependencies
  }

  return inputs
}

export function normalizeApiBaseUrl(domain: string): string {
  const trimmedDomain = domain.trim()
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmedDomain) ? trimmedDomain : `https://${trimmedDomain}`
  const url = new URL(withScheme)
  url.hash = ""
  url.search = ""
  const pathname = url.pathname.replace(/\/+$/, "")

  if (!pathname.endsWith("/api")) {
    url.pathname = `${pathname}/api`
  } else {
    url.pathname = pathname
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
}

function readRequiredInput(name: string): string {
  const value = readOptionalInput(name)
  if (!value) {
    throw new Error(`Input "${name}" is required.`)
  }

  return value
}

function readOptionalInput(name: string): string | undefined {
  const value = core.getInput(name)
  return value.trim() ? value.trim() : undefined
}

function parseListInput(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseDependencies(value: string | undefined): unknown[] | undefined {
  if (!value) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Input "dependencies" must be valid JSON.')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Input "dependencies" must be a JSON array.')
  }

  return parsed
}

function parseIntegerInput(name: string, defaultValue: number, min: number): number {
  const value = readOptionalInput(name)
  if (!value) {
    return defaultValue
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Input "${name}" must be an integer >= ${min}.`)
  }

  return parsed
}

function parseFailMode(value: string | undefined): FailMode {
  if (!value) {
    return "fail"
  }

  if (value === "fail" || value === "warn" || value === "skip") {
    return value
  }

  throw new Error('Input "fail-mode" must be "fail", "warn", or "skip".')
}

async function readChangelogFile(filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf8")).trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected file read failure"
    throw new Error(`Unable to read changelog file "${filePath}": ${message}`, { cause: error })
  }
}

function parseBooleanInput(name: string, defaultValue: boolean): boolean {
  const value = readOptionalInput(name)
  if (!value) {
    return defaultValue
  }

  if (value === "true") {
    return true
  }

  if (value === "false") {
    return false
  }

  throw new Error(`Input "${name}" must be "true" or "false".`)
}

function resolveVersion(value: string | undefined): string {
  const resolved = value ?? readGitRefVersion()
  if (!resolved) {
    throw new Error("Unable to resolve version from input or GITHUB_REF_NAME.")
  }

  if (resolved.length > 32 || !urlSafeRegex.test(resolved)) {
    throw new Error(`Invalid version "${resolved}".`)
  }

  return resolved
}

function readGitRefVersion(): string | undefined {
  const refName = process.env.GITHUB_REF_NAME?.trim()
  if (!refName) {
    return undefined
  }

  const derived = refName.startsWith("v") ? refName.slice(1) : refName
  return derived.trim() ? derived.trim() : undefined
}
