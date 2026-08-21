import * as core from "@actions/core"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ActionInputs, parseInputs } from "../src/inputs"
import { buildProjectVersionData, ResolvedUploadFile } from "../src/metadata"

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	setSecret: vi.fn(),
	warning: vi.fn(),
	notice: vi.fn(),
}))

const mockedCore = vi.mocked(core)

let tempDir: string

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "guizhan-action-metadata-"))
	mockedCore.getInput.mockReset()
	mockedCore.setSecret.mockReset()
	vi.unstubAllEnvs()
})

afterEach(async () => {
	await fs.rm(tempDir, { force: true, recursive: true })
	vi.unstubAllEnvs()
})

describe("buildProjectVersionData", () => {
	it("uses explicit Minecraft versions and platforms over auto-detection", async () => {
		const files = await createResolvedFiles(["Plugin-1.20.4-paper.jar"])
		const { data } = await buildProjectVersionData(
			createInputs({ minecraftVersions: ["1.21.1"], platforms: ["folia"] }),
			files,
		)

		expect(data.minecraft_versions).toEqual(["1.21.1"])
		expect(data.platforms).toEqual(["folia"])
	})

	it("builds API data with detected metadata and final file order", async () => {
		const files = await createResolvedFiles(["Plugin-1.20.4-paper.jar", "Docs.zip"], {
			"Plugin-1.20.4-paper.jar": ["paper-plugin.yml"],
			"Docs.zip": [],
		})

		const { data } = await buildProjectVersionData(createInputs({ changelog: "Release notes", failMode: "warn" }), files)

		expect(data).toEqual({
			channel: "stable",
			version: "1.0.0",
			name: "1.0.0",
			changelog: "Release notes",
			minecraft_versions: ["1.20.4"],
			platforms: ["paper"],
			files: ["Plugin-1.20.4-paper.jar", "Docs.zip"],
		})
	})

	it("omits optional detected fields when detection finds nothing", async () => {
		const files = await createResolvedFiles(["Plugin.jar"], { "Plugin.jar": [] })

		const { data } = await buildProjectVersionData(createInputs({ failMode: "warn" }), files)

		expect(data).toEqual({
			channel: "stable",
			version: "1.0.0",
			name: "1.0.0",
			files: ["Plugin.jar"],
		})
		expect(data.minecraft_versions).toBeUndefined()
		expect(data.platforms).toBeUndefined()
	})

	it("omits auto-detected fields when detection is disabled", async () => {
		const files = await createResolvedFiles(["Plugin-1.20.4-paper.jar"], {
			"Plugin-1.20.4-paper.jar": ["paper-plugin.yml"],
		})

		const { data } = await buildProjectVersionData(
			createInputs({ autoDetectMinecraft: false, autoDetectPlatform: false }),
			files,
		)

		expect(data.minecraft_versions).toBeUndefined()
		expect(data.platforms).toBeUndefined()
	})

	it("rejects unsupported explicit platform inputs", async () => {
		const files = await createResolvedFiles(["Plugin.jar"], { "Plugin.jar": [] })

		await expect(
			buildProjectVersionData(createInputs({ autoDetectMinecraft: false, platforms: ["velocity"] }), files),
		).rejects.toThrow(
			'Unsupported platform "velocity".',
		)
	})

	it("includes dependencies when present", async () => {
		const files = await createResolvedFiles(["Plugin.jar"], { "Plugin.jar": [] })
		const dependencies = [{ type: "required", version_id: "abcd1234" }]

		const { data } = await buildProjectVersionData(
			createInputs({ autoDetectMinecraft: false, autoDetectPlatform: false, dependencies }),
			files,
		)

		expect(data.dependencies).toEqual(dependencies)
	})

	it("detects Minecraft versions from filenames", async () => {
		const files = await createResolvedFiles(["Plugin-1.21.4.jar", "Plugin-1.20.1.zip"], {
			"Plugin-1.21.4.jar": [],
			"Plugin-1.20.1.zip": [],
		})

		const { data } = await buildProjectVersionData(createInputs({ autoDetectPlatform: false }), files)

		expect(data.minecraft_versions).toEqual(["1.21.4", "1.20.1"])
	})

	it("detects year-based Minecraft versions from filenames", async () => {
		const files = await createResolvedFiles(["Plugin-26.1-fabric.jar", "Addon-27.10.2.zip"], {
			"Plugin-26.1-fabric.jar": [],
			"Addon-27.10.2.zip": [],
		})

		const { data } = await buildProjectVersionData(createInputs({ autoDetectPlatform: false }), files)

		expect(data.minecraft_versions).toEqual(["26.1", "27.10.2"])
	})

	it("fails by default when a file cannot be parsed or has no detected metadata", async () => {
		const files = await createResolvedFiles(["Empty.jar"], { "Empty.jar": [] })

		await expect(buildProjectVersionData(createInputs(), files)).rejects.toThrow(
			'Unable to detect metadata for "Empty.jar".',
		)
	})

	it("warns and keeps the file when fail-mode is warn", async () => {
		const files = await createResolvedFiles(["Empty.jar", "Plugin-1.20.4-paper.jar"], {
			"Empty.jar": [],
			"Plugin-1.20.4-paper.jar": [],
		})

		const { data, files: usableFiles } = await buildProjectVersionData(createInputs({ failMode: "warn" }), files)

		expect(usableFiles.map((file) => file.basename)).toEqual(["Empty.jar", "Plugin-1.20.4-paper.jar"])
		expect(data.files).toEqual(["Empty.jar", "Plugin-1.20.4-paper.jar"])
		expect(mockedCore.warning).toHaveBeenCalledWith(
			expect.stringContaining('Unable to detect metadata for "Empty.jar"'),
		)
	})

	it("excludes unusable files when fail-mode is skip", async () => {
		const files = await createResolvedFiles(["Empty.jar", "Plugin-1.20.4-paper.jar"], {
			"Empty.jar": [],
			"Plugin-1.20.4-paper.jar": [],
		})

		const { data, files: usableFiles } = await buildProjectVersionData(createInputs({ failMode: "skip" }), files)

		expect(usableFiles.map((file) => file.basename)).toEqual(["Plugin-1.20.4-paper.jar"])
		expect(data.files).toEqual(["Plugin-1.20.4-paper.jar"])
		expect(data.minecraft_versions).toEqual(["1.20.4"])
	})
})

describe("metadata input dependencies", () => {
	it("rejects invalid dependencies JSON before metadata assembly", async () => {
		setValidInputMap({ dependencies: "not-json" })
		vi.stubEnv("GITHUB_REF_NAME", "v1.0.0")

		await expect(parseInputs()).rejects.toThrow('Input "dependencies" must be valid JSON.')
	})
})

function createInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
	return {
		apiBaseUrl: "https://resources.guizhanss.com/api",
		token: "ghs_test_token",
		projectId: "project-123",
		channel: "stable",
		files: ["Plugin.jar"],
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

async function createResolvedFiles(
	basenames: string[],
	jarEntriesByBasename: Record<string, string[]> = {},
): Promise<ResolvedUploadFile[]> {
	const files: ResolvedUploadFile[] = []

	for (const basename of basenames) {
		const filePath = path.join(tempDir, basename)
		const jarEntries = jarEntriesByBasename[basename]
		await fs.writeFile(filePath, jarEntries ? createZip(jarEntries) : "fixture")
		files.push({ basename, path: filePath })
	}

	return files
}

function setValidInputMap(overrides: Record<string, string | undefined> = {}) {
	mockedCore.getInput.mockImplementation(
		(name: string) =>
			({
				domain: "resources.guizhanss.com",
				token: "ghs_test_token",
				"project": "project-123",
				channel: "stable",
				files: "Plugin.jar",
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
			})[name] ?? "",
	)
}

function createZip(entries: string[]) {
	const localHeaders: Buffer[] = []
	const centralHeaders: Buffer[] = []
	let localOffset = 0

	for (const entry of entries) {
		const name = Buffer.from(entry, "utf8")
		const localHeader = Buffer.alloc(30 + name.length)
		localHeader.writeUInt32LE(0x04034b50, 0)
		localHeader.writeUInt16LE(20, 4)
		localHeader.writeUInt16LE(name.length, 26)
		name.copy(localHeader, 30)
		localHeaders.push(localHeader)

		const centralHeader = Buffer.alloc(46 + name.length)
		centralHeader.writeUInt32LE(0x02014b50, 0)
		centralHeader.writeUInt16LE(20, 4)
		centralHeader.writeUInt16LE(20, 6)
		centralHeader.writeUInt16LE(name.length, 28)
		centralHeader.writeUInt32LE(localOffset, 42)
		name.copy(centralHeader, 46)
		centralHeaders.push(centralHeader)

		localOffset += localHeader.length
	}

	const centralDirectory = Buffer.concat(centralHeaders)
	const endOfCentralDirectory = Buffer.alloc(22)
	endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
	endOfCentralDirectory.writeUInt16LE(entries.length, 8)
	endOfCentralDirectory.writeUInt16LE(entries.length, 10)
	endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
	endOfCentralDirectory.writeUInt32LE(localOffset, 16)

	return Buffer.concat([...localHeaders, centralDirectory, endOfCentralDirectory])
}
