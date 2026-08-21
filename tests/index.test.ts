import * as core from "@actions/core"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { run } from "../src/index"

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	setFailed: vi.fn(),
	setOutput: vi.fn(),
	setSecret: vi.fn(),
	warning: vi.fn(),
	notice: vi.fn(),
}))

const mockedCore = vi.mocked(core)
const mockedFetch = vi.fn()

let testDirectory: string

beforeEach(async () => {
	testDirectory = await mkdtemp(path.join(tmpdir(), "guizhan-resources-index-test-"))
	mockedCore.getInput.mockReset()
	mockedCore.setFailed.mockReset()
	mockedCore.setOutput.mockReset()
	mockedCore.setSecret.mockReset()
	mockedFetch.mockReset()
	vi.stubGlobal("fetch", mockedFetch)
})

afterEach(async () => {
	await rm(testDirectory, { force: true, recursive: true })
	vi.unstubAllGlobals()
})

describe("run", () => {
	it("sends the create-version multipart contract and sets all success outputs", async () => {
		await setUploadInputs({
			changelog: "Release notes",
			dependencies: JSON.stringify([{ type: "required", version_id: "abcd1234" }]),
			"minecraft-versions": "1.21.1",
			platforms: "paper",
		})
		mockedFetch.mockResolvedValue(jsonResponse({ code: 0, message: "Created", data: { id: "version-123" } }))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(1)
		const [url, request] = mockedFetch.mock.calls[0]
		expect(url).toBe("https://resources.guizhanss.com/api/v1/projects/project%20%2F%20slug/versions")
		expect(request).toMatchObject({
			method: "POST",
			headers: { Authorization: "Bearer ghs_test_token" },
		})

		const body = (request as RequestInit).body as FormData
		expect(body).toBeInstanceOf(FormData)
		expect((request as RequestInit).headers).not.toHaveProperty("Content-Type")
		expect((request as RequestInit).headers).not.toHaveProperty("content-type")
		expect(JSON.parse(body.get("data") as string)).toEqual({
			channel: "stable",
			version: "1.0.0",
			name: "Release 1.0.0",
			changelog: "Release notes",
			minecraft_versions: ["1.21.1"],
			platforms: ["paper"],
			dependencies: [{ type: "required", version_id: "abcd1234" }],
			files: ["plugin.jar", "addon.zip"],
		})
		const entries = Array.from(body.entries())
		expect(entries.map(([name]) => name)).toEqual(["data", "plugin.jar", "addon.zip"])
		const expectedFileContents: Record<string, string> = {
			"addon.zip": "addon-bytes",
			"plugin.jar": "plugin-bytes",
		}
		for (const [name, value] of entries.slice(1)) {
			expect(value).toBeInstanceOf(Blob)
			expect((value as Blob & { name: string }).name).toBe(name)
			await expect((value as Blob).text()).resolves.toBe(expectedFileContents[name])
		}

		expect(mockedCore.setOutput).toHaveBeenCalledTimes(4)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-123")
		expect(mockedCore.setOutput).toHaveBeenCalledWith(
			"version-url",
			"https://resources.guizhanss.com/project/project / slug/versions/version-123",
		)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("uploaded-files", "plugin.jar,addon.zip")
		expect(mockedCore.setOutput).toHaveBeenCalledWith("api-code", "0")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("excludes skipped files from the upload payload when fail-mode is skip", async () => {
		const pluginPath = await createFile("dist/Plugin-1.20.4-paper.jar", createEmptyZip())
		const addonPath = await createFile("dist/addon.zip", "addon-bytes")
		await setUploadInputs({
			files: `${addonPath},${pluginPath}`,
			"primary-file": "Plugin-1.20.4-paper.jar",
			"auto-detect-minecraft": "true",
			"fail-mode": "skip",
		})
		mockedFetch.mockResolvedValue(jsonResponse({ code: 0, message: "Created", data: { id: "version-123" } }))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(1)
		const [, request] = mockedFetch.mock.calls[0]
		const body = (request as RequestInit).body as FormData
		expect(Array.from(body.keys())).toEqual(["data", "Plugin-1.20.4-paper.jar"])
		const data = JSON.parse(body.get("data") as string)
		expect(data.files).toEqual(["Plugin-1.20.4-paper.jar"])
		expect(data.minecraft_versions).toEqual(["1.20.4"])
		expect(mockedCore.setOutput).toHaveBeenCalledWith("uploaded-files", "Plugin-1.20.4-paper.jar")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("reports API errors while preserving the response code output", async () => {
		await setUploadInputs()
		mockedFetch.mockResolvedValue(jsonResponse({ code: 5000, message: "Invalid project", data: {} }, 400))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(1)
		expect(mockedCore.setOutput).toHaveBeenCalledTimes(1)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("api-code", "5000")
		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("5000"))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("Invalid project"))
	})

	it("fails when a successful HTTP response has a nonzero API code", async () => {
		await setUploadInputs()
		mockedFetch.mockResolvedValue(jsonResponse({ code: 5300, message: "Invalid channel", data: { id: "version-123" } }))

		await run()

		expect(mockedCore.setOutput).toHaveBeenCalledTimes(1)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("api-code", "5300")
		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("Invalid channel"))
	})

	it("fails without success outputs when a successful response has no version id", async () => {
		await setUploadInputs()
		mockedFetch.mockResolvedValue(jsonResponse({ code: 0, message: "OK", data: {} }))

		await run()

		expect(mockedCore.setOutput).toHaveBeenCalledTimes(1)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("api-code", "0")
		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("malformed"))
	})

	it("fails when an error response carries a zero API code", async () => {
		await setUploadInputs()
		mockedFetch.mockResolvedValue(jsonResponse({ code: 0, message: "OK", data: { id: "version-123" } }, 400))

		await run()

		expect(mockedCore.setOutput).toHaveBeenCalledTimes(1)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("api-code", "0")
		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("400"))
	})

	it("does not retry malformed 4xx JSON responses", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch.mockResolvedValue(
			new Response("<html><body>Bad request</body></html>", {
				status: 400,
				headers: { "content-type": "text/html" },
			}),
		)

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(1)
		expect(mockedCore.setOutput).not.toHaveBeenCalled()
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"))
	})

	it("fails without an API code when the request cannot be sent", async () => {
		await setUploadInputs()
		mockedFetch.mockRejectedValue(new Error("Network unavailable"))

		await run()

		expect(mockedCore.setOutput).not.toHaveBeenCalled()
		expect(mockedCore.setFailed).toHaveBeenCalledWith("Network unavailable")
	})

	it("retries transient server errors and succeeds on a later attempt", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch
			.mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
			.mockResolvedValueOnce(jsonResponse({ code: 0, message: "Created", data: { id: "version-123" } }))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(2)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-123")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("does not retry client errors", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch.mockResolvedValue(jsonResponse({ code: 5000, message: "Invalid project", data: {} }, 400))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(1)
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("5000"))
	})

	it("retries transport errors", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch
			.mockRejectedValueOnce(new Error("Network unavailable"))
			.mockResolvedValueOnce(jsonResponse({ code: 0, message: "Created", data: { id: "version-123" } }))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(2)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-123")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("retries response body transport failures", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch
			.mockResolvedValueOnce(bodyReadFailureResponse(400))
			.mockResolvedValueOnce(jsonResponse({ code: 0, message: "Created", data: { id: "version-123" } }))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(2)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-123")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("fails after exhausting all attempts", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch.mockRejectedValue(new Error("Network unavailable"))

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(2)
		expect(mockedCore.setFailed).toHaveBeenCalledWith("Network unavailable")
	})

	it("treats a matching existing version as an idempotent success", async () => {
		await setUploadInputs()
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(existingVersionResponse())

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(2)
		expect(mockedFetch.mock.calls[1]?.[0]).toBe(
			"https://resources.guizhanss.com/api/v1/projects/project%20%2F%20slug/versions/1.0.0",
		)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-existing")
		expect(mockedCore.setOutput).toHaveBeenCalledWith(
			"version-url",
			"https://resources.guizhanss.com/project/project / slug/versions/version-existing",
		)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("uploaded-files", "plugin.jar,addon.zip")
		expect(mockedCore.setOutput).toHaveBeenCalledWith("api-code", "0")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("matches reordered structurally equivalent dependencies during replay verification", async () => {
		await setUploadInputs({
			dependencies: JSON.stringify([
				{ type: "required", version_id: "vers1234" },
				{ type: "optional", project_id: "proj1234" },
			]),
		})
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(
				existingVersionResponse({
					dependencies: [
						{ project_id: "proj1234", type: "optional" },
						{ version_id: "vers1234", type: "required" },
					],
				}),
			)

		await run()

		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-existing")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("fails replay verification when dependencies differ", async () => {
		await setUploadInputs({ dependencies: JSON.stringify([{ type: "required", version_id: "vers1234" }]) })
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(existingVersionResponse({ dependencies: [{ type: "required", version_id: "other123" }] }))

		await run()

		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("dependencies"))
	})

	it("compares auto-detected metadata from the uploaded version data during replay verification", async () => {
		const detectedPluginPath = await createFile("detected/Plugin-1.20.4-paper.jar", "plugin-bytes")
		const addonPath = await createFile("detected/addon.zip", "addon-bytes")
		await setUploadInputs({
			files: `${addonPath},${detectedPluginPath}`,
			"primary-file": "Plugin-1.20.4-paper.jar",
			"auto-detect-minecraft": "true",
			"auto-detect-platform": "true",
			"fail-mode": "warn",
		})
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(
				existingVersionResponse({
					minecraft_versions: ["1.21.1"],
					platforms: ["folia"],
					files: [
						existingFile("Plugin-1.20.4-paper.jar", "plugin-bytes", true),
						existingFile("addon.zip", "addon-bytes", false),
					],
				}),
			)

		await run()

		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("minecraft_versions"))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("platforms"))
	})

	it("matches a three-file version when secondary files are returned in a different order", async () => {
		const addonPath = path.join(testDirectory, "dist/addon.zip")
		const pluginPath = path.join(testDirectory, "dist/plugin.jar")
		const thirdPath = await createFile("dist/third.jar", "third-bytes")
		await setUploadInputs({ files: `${addonPath},${pluginPath},${thirdPath}` })
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(
				existingVersionResponse({
					files: [
						existingFile("third.jar", "third-bytes", false),
						existingFile("plugin.jar", "plugin-bytes", true),
						existingFile("addon.zip", "addon-bytes", false),
					],
				}),
			)

		await run()

		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-existing")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("rejects replay files with external URLs or incorrect primary flags", async () => {
		await setUploadInputs()
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(
				existingVersionResponse({
					files: [
						existingFile("plugin.jar", "plugin-bytes", false),
						{ ...existingFile("addon.zip", "addon-bytes", true), external_url: "https://example.com/addon.zip" },
					],
				}),
			)

		await run()

		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('file "plugin.jar"'))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('file "addon.zip"'))
	})

	it("fails replay verification when the successful-looking response has a nonzero code", async () => {
		await setUploadInputs()
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(existingVersionResponse({}, 5301))

		await run()

		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("verification response was unsuccessful"))
	})

	it("retries a 5xx before reconciling a matching existing version", async () => {
		await setUploadInputs({ "retry-attempts": "2" })
		mockedFetch
			.mockResolvedValueOnce(new Response("upstream error", { status: 503 }))
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(existingVersionResponse())

		await run()

		expect(mockedFetch).toHaveBeenCalledTimes(3)
		expect(mockedCore.setOutput).toHaveBeenCalledWith("version-id", "version-existing")
		expect(mockedCore.setFailed).not.toHaveBeenCalled()
	})

	it("fails when the existing version does not match the request", async () => {
		await setUploadInputs()
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(existingVersionResponse({ name: "Different name" }))

		await run()

		expect(mockedCore.setOutput).not.toHaveBeenCalledWith("version-id", expect.any(String))
		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("does not match"))
	})

	it("fails when the existing version cannot be fetched for verification", async () => {
		await setUploadInputs()
		mockedFetch
			.mockResolvedValueOnce(jsonResponse({ code: 5301, message: "Project version already exists", data: {} }, 400))
			.mockResolvedValueOnce(jsonResponse({ code: 5300, message: "Not found", data: {} }, 404))

		await run()

		expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining("verification failed"))
	})
})

async function setUploadInputs(overrides: Record<string, string> = {}) {
	const addonPath = await createFile("dist/addon.zip", "addon-bytes")
	const pluginPath = await createFile("dist/plugin.jar", "plugin-bytes")
	mockedCore.getInput.mockImplementation(
		(name: string) =>
			({
				domain: "https://resources.guizhanss.com/api/",
				token: "ghs_test_token",
				"project": "project / slug",
				channel: "stable",
				files: `${addonPath},${pluginPath}`,
				"artifact-names": "",
				"primary-file": "plugin.jar",
				version: "1.0.0",
				name: "Release 1.0.0",
				changelog: "",
				"minecraft-versions": "",
				platforms: "",
				dependencies: "",
				"auto-detect-minecraft": "false",
				"auto-detect-platform": "false",
				"retry-attempts": "1",
				"retry-delay": "0",
				...overrides,
			})[name] ?? "",
	)
}

async function createFile(relativePath: string, content: string | Buffer) {
	const filePath = path.join(testDirectory, relativePath)
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, content)
	return filePath
}

function createEmptyZip() {
	const archive = Buffer.alloc(22)
	archive.writeUInt32LE(0x06054b50, 0)
	return archive
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

function existingVersionResponse(overrides: Record<string, unknown> = {}, code = 0) {
	return jsonResponse({
		code,
		message: "OK",
		data: {
			id: "version-existing",
			version: "1.0.0",
			name: "Release 1.0.0",
			channel: { id: "chan-123", slug: "stable" },
			files: [
				existingFile("plugin.jar", "plugin-bytes", true),
				existingFile("addon.zip", "addon-bytes", false),
			],
			...overrides,
		},
	})
}

function existingFile(name: string, content: string, isPrimary: boolean) {
	return {
		name,
		size: Buffer.byteLength(content),
		checksum: { sha1: "a", sha256: sha256Hex(content) },
		is_primary: isPrimary,
	}
}

function bodyReadFailureResponse(status: number) {
	const response = new Response(JSON.stringify({ code: 0, data: { id: "version-123" } }), { status })
	Object.defineProperty(response, "text", { value: () => Promise.reject(new Error("Response body interrupted")) })
	return response
}

function sha256Hex(content: string) {
	return createHash("sha256").update(content).digest("hex")
}
