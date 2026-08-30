import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { collectFiles } from "../src/files"
import { ActionInputs } from "../src/inputs"

let testDirectory: string

beforeEach(async () => {
  testDirectory = await mkdtemp(path.join(tmpdir(), "guizhan-resources-files-test-"))
})

afterEach(async () => {
  await rm(testDirectory, { force: true, recursive: true })
})

describe("collectFiles", () => {
  it("resolves a single local path", async () => {
    const filePath = await createFile("build/plugin.jar")

    const result = await collectFiles(createInputs({ files: [filePath] }))

    expect(result).toEqual([{ path: filePath, basename: "plugin.jar" }])
  })

  it("resolves glob patterns deterministically", async () => {
    const addonPath = await createFile("dist/addon.zip")
    const pluginPath = await createFile("dist/plugin.jar")

    const result = await collectFiles(createInputs({ files: [path.join(testDirectory, "dist", "*")] }))

    expect(result).toEqual([
      { path: addonPath, basename: "addon.zip" },
      { path: pluginPath, basename: "plugin.jar" },
    ])
  })

  it("filters unrelated sidecar files from glob matches", async () => {
    const pluginPath = await createFile("dist/plugin.jar")
    await createFile("dist/notes.md")
    await createFile("dist/plugin.jar.sha1")
    await createFile("dist/checksums.json")

    const result = await collectFiles(createInputs({ files: [path.join(testDirectory, "dist", "*")] }))

    expect(result).toEqual([{ path: pluginPath, basename: "plugin.jar" }])
  })

  it("uploads a file matched by literal path and glob only once", async () => {
    const pluginPath = await createFile("dist/plugin.jar")

    const result = await collectFiles(createInputs({ files: [pluginPath, path.join(testDirectory, "dist", "*.jar")] }))

    expect(result).toEqual([{ path: pluginPath, basename: "plugin.jar" }])
  })

  it("fails when a glob pattern has no matches", async () => {
    await expect(collectFiles(createInputs({ files: [path.join(testDirectory, "missing", "*.jar")] }))).rejects.toThrow(
      "did not match any files"
    )
  })

  it("rejects directories", async () => {
    const directoryPath = path.join(testDirectory, "dist")
    await mkdir(directoryPath, { recursive: true })

    await expect(collectFiles(createInputs({ files: [directoryPath] }))).rejects.toThrow("is a directory")
  })

  it("rejects unsupported file extensions", async () => {
    const filePath = await createFile("dist/plugin.txt")

    await expect(collectFiles(createInputs({ files: [filePath] }))).rejects.toThrow("unsupported extension")
  })

  it("rejects unsafe basenames", async () => {
    const filePath = await createFile("dist/-plugin.jar")

    await expect(collectFiles(createInputs({ files: [filePath] }))).rejects.toThrow("unsafe basename")
  })

  it("rejects duplicate basenames", async () => {
    const firstPath = await createFile("a/plugin.jar")
    const secondPath = await createFile("b/plugin.jar")

    await expect(collectFiles(createInputs({ files: [secondPath, firstPath] }))).rejects.toThrow(
      'Duplicate upload basename "plugin.jar"'
    )
  })

  it("collects nested artifact files without preserving nested basenames", async () => {
    const artifactClient = createArtifactClient({
      "build-output": async (downloadPath) => {
        await createFileAt(downloadPath, "nested/plugin.jar")
        await createFileAt(downloadPath, "release/addon.zip")
      },
    })

    const result = await collectFiles(createInputs({ files: [], artifactNames: ["build-output"] }), artifactClient)

    expect(result.map((file) => file.basename)).toEqual(["addon.zip", "plugin.jar"])
    expect(result.map((file) => path.relative(path.dirname(result[0].path), file.basename))).not.toContain(
      "nested/plugin.jar"
    )
    expect(artifactClient.downloadArtifact).toHaveBeenCalledWith(1, { path: expect.any(String) })
  })

  it("fails when an artifact is not found", async () => {
    const artifactClient = createArtifactClient({ "other-artifact": async () => {} })

    await expect(
      collectFiles(createInputs({ files: [], artifactNames: ["missing-artifact"] }), artifactClient)
    ).rejects.toThrow('Artifact "missing-artifact" was not found')
  })

  it("moves the primary file basename to the first position", async () => {
    const addonPath = await createFile("dist/addon.zip")
    const pluginPath = await createFile("dist/plugin.jar")

    const result = await collectFiles(createInputs({ files: [pluginPath, addonPath], primaryFile: "plugin.jar" }))

    expect(result).toEqual([
      { path: pluginPath, basename: "plugin.jar" },
      { path: addonPath, basename: "addon.zip" },
    ])
  })

  it("fails when the primary file basename is missing", async () => {
    const filePath = await createFile("dist/plugin.jar")

    await expect(collectFiles(createInputs({ files: [filePath], primaryFile: "missing.zip" }))).rejects.toThrow(
      'Primary file "missing.zip" was not found'
    )
  })
})

function createInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiBaseUrl: "https://resources.guizhanss.com/api",
    token: "token",
    projectId: "project",
    channel: "stable",
    files: [],
    artifactNames: [],
    version: "1.0.0",
    name: "1.0.0",
    autoDetectMinecraft: true,
    autoDetectPlatform: true,
    retryAttempts: 2,
    retryDelayMs: 0,
    failMode: "fail",
    ...overrides,
  }
}

async function createFile(relativePath: string) {
  return createFileAt(testDirectory, relativePath)
}

async function createFileAt(rootDirectory: string, relativePath: string) {
  const filePath = path.join(rootDirectory, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, "fixture")
  return filePath
}

function createArtifactClient(artifacts: Record<string, (downloadPath: string) => Promise<void>>) {
  const artifactNames = Object.keys(artifacts)

  return {
    listArtifacts: vi.fn(async () => ({
      artifacts: artifactNames.map((name, index) => ({ name, id: index + 1, size: 1 })),
    })),
    downloadArtifact: vi.fn(async (artifactId: number, options?: { path?: string }) => {
      const artifactName = artifactNames[artifactId - 1]
      if (!artifactName || !options?.path) {
        throw new Error("Invalid artifact test setup")
      }

      await artifacts[artifactName](options.path)
      return { downloadPath: options.path }
    }),
  }
}
