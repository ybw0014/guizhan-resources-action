import * as core from "@actions/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeApiBaseUrl, parseInputs } from "../src/inputs"

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	setSecret: vi.fn(),
}))

const mockedCore = vi.mocked(core)

type InputMap = Record<string, string | undefined>

function setInputs(values: InputMap) {
	mockedCore.getInput.mockImplementation((name: string) => values[name] ?? "")
}

function setValidBaseInputs(overrides: InputMap = {}) {
	setInputs({
		domain: "resources.guizhanss.com",
		token: "ghs_test_token",
		"project-id": "project-123",
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
		expect(normalizeApiBaseUrl("https://resources.guizhanss.com/api/")).toBe(
			"https://resources.guizhanss.com/api",
		)
	})

	it("preserves existing api paths", () => {
		expect(normalizeApiBaseUrl("https://staging.resources.guizhanss.com/api")).toBe(
			"https://staging.resources.guizhanss.com/api",
		)
	})
})

describe("parseInputs", () => {
	it("parses and normalizes the action inputs", () => {
		setValidBaseInputs({
			domain: "resources.guizhanss.com/",
			files: "build/app.jar,\nrelease/addon.zip",
			"artifact-names": "upload-one,\nupload-two",
			name: "",
			"minecraft-versions": "1.20.1,\n1.21.1",
			platforms: "paper\nfolia",
			dependencies:
				"[{\"type\":\"required\",\"version_id\":\"12345678\"}]",
			"auto-detect-minecraft": "false",
			"auto-detect-platform": "true",
		})

		const result = parseInputs()

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
		})
		expect(mockedCore.setSecret).toHaveBeenCalledWith("ghs_test_token")
	})

	it("preserves staging api domains", () => {
		expect(normalizeApiBaseUrl("https://staging.resources.guizhanss.com/api/")).toBe(
			"https://staging.resources.guizhanss.com/api",
		)
	})

	it("fails when token is missing", () => {
		setValidBaseInputs({ token: "" })

		expect(() => parseInputs()).toThrow('Input "token" is required.')
		expect(mockedCore.setSecret).not.toHaveBeenCalled()
	})

	it("fails when project id is missing", () => {
		setValidBaseInputs({ "project-id": "" })

		expect(() => parseInputs()).toThrow('Input "project-id" is required.')
	})

	it("fails when channel is missing", () => {
		setValidBaseInputs({ channel: "" })

		expect(() => parseInputs()).toThrow('Input "channel" is required.')
	})

	it("fails when no files or artifact names are provided", () => {
		setValidBaseInputs({ files: "", "artifact-names": "" })

		expect(() => parseInputs()).toThrow('At least one of "files" or "artifact-names" is required.')
	})

	it("fails on invalid dependencies json", () => {
		setValidBaseInputs({ dependencies: "not-json" })

		expect(() => parseInputs()).toThrow('Input "dependencies" must be valid JSON.')
		expect(mockedCore.setSecret).toHaveBeenCalledWith("ghs_test_token")
	})

	it("fails when derived version is invalid", () => {
		setValidBaseInputs({ version: "" })
		vi.stubEnv("GITHUB_REF_NAME", "vbad/version")

		expect(() => parseInputs()).toThrow('Invalid version "bad/version".')
	})

	it("fails when version cannot be derived", () => {
		setValidBaseInputs({ version: "" })
		vi.stubEnv("GITHUB_REF_NAME", "")

		expect(() => parseInputs()).toThrow("Unable to resolve version from input or GITHUB_REF_NAME.")
	})

	it("masks the token before doing later work", () => {
		const events: string[] = []
		setInputs({
			domain: "resources.guizhanss.com",
			token: "ghs_mask_me",
			"project-id": "project-123",
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
			return {
				domain: "resources.guizhanss.com",
				token: "ghs_mask_me",
				"project-id": "project-123",
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
		})
		mockedCore.setSecret.mockImplementation((value: string) => {
			events.push(`secret:${value}`)
		})

		parseInputs()

		expect(events[0]).toBe("get:token")
		expect(events[1]).toBe("secret:ghs_mask_me")
	})
})
