import * as core from "@actions/core"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeApiBaseUrl, parseInputs } from "../src/inputs"

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
}))

const mockedCore = vi.mocked(core)

let tempDir: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "guizhan-action-inputs-test-"))
})

afterEach(async () => {
  await fs.rm(tempDir, { force: true, recursive: true })
})

type InputMap = Record<string, string | undefined>

function setInputs(values: InputMap) {
  mockedCore.getInput.mockImplementation((name: string) => values[name] ?? "")
}

function setValidBaseInputs(overrides: InputMap = {}) {
  setInputs({
    domain: "resources.guizhanss.com",
    token: "ghs_test_token",
    project: "project-123",
    channel: "stable",
    files: "build/app.jar",
    "artifact-names": "",
    version: "",
    name: "",
    changelog: "",
    "minecraft-versions": "",
    platforms: "",
    dependencies: "",
    "primary-file": "",
    "auto-detect-minecraft": "true",
    "auto-detect-platform": "true",
    ...overrides,
  })
  vi.stubEnv("GITHUB_REF_NAME", "v1.2.3")
}

beforeEach(() => {
  mockedCore.getInput.mockReset()
  mockedCore.setSecret.mockReset()
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("normalizeApiBaseUrl", () => {
  it("normalizes bare domains", () => {
    expect(normalizeApiBaseUrl("resources.guizhanss.com")).toBe("https://resources.guizhanss.com/api")
  })

  it("removes trailing slashes", () => {
    expect(normalizeApiBaseUrl("https://resources.guizhanss.com/api/")).toBe("https://resources.guizhanss.com/api")
  })

  it("preserves existing api paths", () => {
    expect(normalizeApiBaseUrl("https://staging.resources.guizhanss.com/api")).toBe(
      "https://staging.resources.guizhanss.com/api"
    )
  })
})

describe("parseInputs", () => {
  it("parses and normalizes the action inputs", async () => {
    setValidBaseInputs({
      domain: "resources.guizhanss.com/",
      files: "build/app.jar,\nrelease/addon.zip",
      "artifact-names": "upload-one,\nupload-two",
      name: "",
      "minecraft-versions": "1.20.1,\n1.21.1",
      platforms: "paper\nfolia",
      dependencies: '[{"type":"required","version_id":"12345678"}]',
      "auto-detect-minecraft": "false",
      "auto-detect-platform": "true",
    })

    const result = await parseInputs()

    expect(result).toEqual({
      apiBaseUrl: "https://resources.guizhanss.com/api",
      token: "ghs_test_token",
      projectId: "project-123",
      channel: "stable",
      files: ["build/app.jar", "release/addon.zip"],
      artifactNames: ["upload-one", "upload-two"],
      version: "1.2.3",
      name: "1.2.3",
      minecraftVersions: ["1.20.1", "1.21.1"],
      platforms: ["paper", "folia"],
      dependencies: [{ type: "required", version_id: "12345678" }],
      autoDetectMinecraft: false,
      autoDetectPlatform: true,
      retryAttempts: 2,
      retryDelayMs: 1000,
      failMode: "fail",
    })
    expect(mockedCore.setSecret).toHaveBeenCalledWith("ghs_test_token")
  })

  it("preserves staging api domains", () => {
    expect(normalizeApiBaseUrl("https://staging.resources.guizhanss.com/api/")).toBe(
      "https://staging.resources.guizhanss.com/api"
    )
  })

  it("fails when token is missing", async () => {
    setValidBaseInputs({ token: "" })

    await expect(parseInputs()).rejects.toThrow('Input "token" is required.')
    expect(mockedCore.setSecret).not.toHaveBeenCalled()
  })

  it("fails when project id is missing", async () => {
    setValidBaseInputs({ project: "" })

    await expect(parseInputs()).rejects.toThrow('Input "project" is required.')
  })

  it("fails when channel is missing", async () => {
    setValidBaseInputs({ channel: "" })

    await expect(parseInputs()).rejects.toThrow('Input "channel" is required.')
  })

  it("fails when no files or artifact names are provided", async () => {
    setValidBaseInputs({ files: "", "artifact-names": "" })

    await expect(parseInputs()).rejects.toThrow('At least one of "files" or "artifact-names" is required.')
  })

  it("fails on invalid dependencies json", async () => {
    setValidBaseInputs({ dependencies: "not-json" })

    await expect(parseInputs()).rejects.toThrow('Input "dependencies" must be valid JSON.')
    expect(mockedCore.setSecret).toHaveBeenCalledWith("ghs_test_token")
  })

  it("fails when derived version is invalid", async () => {
    setValidBaseInputs({ version: "" })
    vi.stubEnv("GITHUB_REF_NAME", "vbad/version")

    await expect(parseInputs()).rejects.toThrow('Invalid version "bad/version".')
  })

  it("fails when version cannot be derived", async () => {
    setValidBaseInputs({ version: "" })
    vi.stubEnv("GITHUB_REF_NAME", "")

    await expect(parseInputs()).rejects.toThrow("Unable to resolve version from input or GITHUB_REF_NAME.")
  })

  it("fails when retry attempts is not a positive integer", async () => {
    setValidBaseInputs({ "retry-attempts": "0" })

    await expect(parseInputs()).rejects.toThrow('Input "retry-attempts" must be an integer >= 1.')
  })

  it("fails when retry delay is not a non-negative integer", async () => {
    setValidBaseInputs({ "retry-delay": "-1" })

    await expect(parseInputs()).rejects.toThrow('Input "retry-delay" must be an integer >= 0.')
  })

  it("reads the changelog from changelog-file", async () => {
    const changelogPath = path.join(tempDir, "CHANGELOG.md")
    await fs.writeFile(changelogPath, "  File changelog content \n")
    setValidBaseInputs({ "changelog-file": changelogPath })

    const result = await parseInputs()

    expect(result.changelog).toBe("File changelog content")
  })

  it("fails when both changelog and changelog-file are set", async () => {
    setValidBaseInputs({ changelog: "inline", "changelog-file": "/tmp/CHANGELOG.md" })

    await expect(parseInputs()).rejects.toThrow('Only one of "changelog" or "changelog-file" may be set.')
  })

  it("fails on an unknown fail-mode", async () => {
    setValidBaseInputs({ "fail-mode": "ignore" })

    await expect(parseInputs()).rejects.toThrow('Input "fail-mode" must be "fail", "warn", or "skip".')
  })

  it("masks the token before doing later work", async () => {
    const events: string[] = []
    setInputs({
      domain: "resources.guizhanss.com",
      token: "ghs_mask_me",
      project: "project-123",
      channel: "stable",
      files: "build/app.jar",
      "artifact-names": "",
      version: "1.0.0",
      name: "",
      changelog: "",
      "minecraft-versions": "",
      platforms: "",
      dependencies: "",
      "primary-file": "",
      "auto-detect-minecraft": "true",
      "auto-detect-platform": "true",
    })
    vi.stubEnv("GITHUB_REF_NAME", "v1.0.0")
    mockedCore.getInput.mockImplementation((name: string) => {
      events.push(`get:${name}`)
      return (
        {
          domain: "resources.guizhanss.com",
          token: "ghs_mask_me",
          project: "project-123",
          channel: "stable",
          files: "build/app.jar",
          "artifact-names": "",
          version: "1.0.0",
          name: "",
          changelog: "",
          "minecraft-versions": "",
          platforms: "",
          dependencies: "",
          "primary-file": "",
          "auto-detect-minecraft": "true",
          "auto-detect-platform": "true",
        }[name] ?? ""
      )
    })
    mockedCore.setSecret.mockImplementation((value: string) => {
      events.push(`secret:${value}`)
    })

    await parseInputs()

    expect(events[0]).toBe("get:token")
    expect(events[1]).toBe("secret:ghs_mask_me")
  })
})
