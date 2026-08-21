import * as core from "@actions/core"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { collectFiles, ResolvedUploadFile } from "./files"
import { ActionInputs, parseInputs } from "./inputs"
import { buildProjectVersionData } from "./metadata"

type ApiResponse = Record<string, unknown>

type UploadFileContent = {
	basename: string
	content: Buffer
	sha256: string
}

type VersionData = Awaited<ReturnType<typeof buildProjectVersionData>>["data"]

const attemptTimeoutMs = 10 * 60 * 1000

export async function run() {
	try {
		const inputs = await parseInputs()
		const collectedFiles = await collectFiles(inputs)
		const { data: versionData, files: usableFiles } = await buildProjectVersionData(inputs, collectedFiles)
		const contents = await readUploadFiles(usableFiles)
		const result = await createVersionWithRetry(inputs, versionData, contents)

		core.setOutput("version-id", result.versionId)
		core.setOutput(
			"version-url",
			`${getSiteRoot(inputs.apiBaseUrl)}/project/${inputs.projectId}/versions/${result.versionId}`,
		)
		core.setOutput("uploaded-files", contents.map((file) => file.basename).join(","))
	} catch (error) {
		core.setFailed(getErrorMessage(error))
	}
}

async function readUploadFiles(files: ResolvedUploadFile[]): Promise<UploadFileContent[]> {
	const contents: UploadFileContent[] = []
	for (const file of files) {
		const content = await readFile(file.path)
		contents.push({ basename: file.basename, content, sha256: createHash("sha256").update(content).digest("hex") })
	}
	return contents
}

class RetryableUploadError extends Error {}

async function createVersionWithRetry(
	inputs: ActionInputs,
	versionData: VersionData,
	contents: UploadFileContent[],
): Promise<{ versionId: string }> {
	let lastError: unknown

	for (let attempt = 1; attempt <= inputs.retryAttempts; attempt += 1) {
		try {
			return await attemptCreateVersion(inputs, versionData, contents)
		} catch (error) {
			lastError = error
			if (attempt >= inputs.retryAttempts || !isRetryableFailure(error)) {
				throw error
			}
			const delay = inputs.retryDelayMs * attempt + Math.floor(Math.random() * 250)
			core.warning(`Upload attempt ${attempt} failed (${getErrorMessage(error)}); retrying in ${delay} ms.`)
			await sleep(delay)
		}
	}

	throw lastError
}

async function attemptCreateVersion(
	inputs: ActionInputs,
	versionData: VersionData,
	contents: UploadFileContent[],
): Promise<{ versionId: string }> {
	let response: Response
	try {
		response = await fetch(getCreateVersionUrl(inputs.apiBaseUrl, inputs.projectId), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${inputs.token}`,
			},
			body: createUploadFormData(versionData, contents),
			signal: AbortSignal.timeout(attemptTimeoutMs),
		})
	} catch (error) {
		throw new RetryableUploadError(getErrorMessage(error), { cause: error })
	}

	// 5xx responses (including non-JSON Cloudflare error pages) are transient.
	if (response.status >= 500) {
		throw new RetryableUploadError(`API request failed with HTTP ${response.status}`)
	}

	const body = await parseApiResponse(response)
	const apiCode = getApiCode(body)

	if (apiCode !== undefined) {
		core.setOutput("api-code", String(apiCode))
	}

	if (apiCode === 5301) {
		return replayVerifyExistingVersion(inputs, versionData, contents)
	}

	const versionId = getVersionId(body)
	if (!response.ok || body.code !== 0 || !versionId) {
		throw new Error(getApiFailureMessage(response, body, apiCode))
	}

	return { versionId }
}

async function replayVerifyExistingVersion(
	inputs: ActionInputs,
	versionData: VersionData,
	contents: UploadFileContent[],
): Promise<{ versionId: string }> {
	core.notice("Version already exists (code 5301); verifying whether an earlier attempt of this request created it.")

	let response: Response
	try {
		response = await fetch(getVersionUrl(inputs.apiBaseUrl, inputs.projectId, versionData.version), {
			headers: {
				Authorization: `Bearer ${inputs.token}`,
			},
			signal: AbortSignal.timeout(attemptTimeoutMs),
		})
	} catch (error) {
		throw new Error(`Version already exists (5301), but fetching it for verification failed: ${getErrorMessage(error)}`, {
			cause: error,
		})
	}

	if (!response.ok) {
		throw new Error(
			`Version already exists (5301), but fetching it for verification failed with HTTP ${response.status}.`,
		)
	}

	const body = await parseApiResponse(response)
	if (body.code !== 0) {
		throw new Error("Version already exists (5301), but the verification response was unsuccessful.")
	}
	const data = isRecord(body.data) ? body.data : undefined
	const versionId = data && typeof data.id === "string" && data.id.trim() ? data.id : undefined
	if (!data || !versionId) {
		throw new Error("Version already exists (5301), but the verification response was malformed.")
	}

	const mismatches = findVersionMismatches(versionData, data, contents)
	if (mismatches.length > 0) {
		throw new Error(`Version already exists (5301) but does not match this request: ${mismatches.join("; ")}.`)
	}

	core.setOutput("api-code", "0")
	core.notice("The existing version matches this request; treating it as created by an earlier attempt.")
	return { versionId }
}

function findVersionMismatches(versionData: VersionData, data: ApiResponse, contents: UploadFileContent[]): string[] {
	const mismatches: string[] = []

	if (data.version !== versionData.version) {
		mismatches.push(`version (existing: ${String(data.version)})`)
	}
	if (data.name !== versionData.name) {
		mismatches.push(`name (existing: ${String(data.name)})`)
	}

	const channel = isRecord(data.channel) ? data.channel : undefined
	if (
		channel?.id !== versionData.channel &&
		(typeof channel?.slug !== "string" || channel.slug.toLowerCase() !== versionData.channel.toLowerCase())
	) {
		mismatches.push("channel")
	}

	// Only compare metadata the uploaded payload sets; omitted fields fall
	// back to channel defaults on the server side.
	if (versionData.platforms !== undefined && !isSameStringSet(data.platforms, versionData.platforms)) {
		mismatches.push("platforms")
	}
	if (versionData.minecraft_versions !== undefined && !isSameStringSet(data.minecraft_versions, versionData.minecraft_versions)) {
		mismatches.push("minecraft_versions")
	}
	if (versionData.changelog !== undefined && data.changelog !== versionData.changelog) {
		mismatches.push("changelog")
	}
	if (versionData.dependencies !== undefined && !isSameDependencies(data.dependencies, versionData.dependencies)) {
		mismatches.push("dependencies")
	}

	mismatches.push(...findFileMismatches(data, contents))

	return mismatches
}

function findFileMismatches(data: ApiResponse, contents: UploadFileContent[]): string[] {
	const fetchedFiles = Array.isArray(data.files) ? data.files : undefined
	if (!fetchedFiles || fetchedFiles.length !== contents.length) {
		return [`files (existing count: ${fetchedFiles?.length ?? 0})`]
	}

	const fetchedByBasename = new Map<string, ApiResponse>()
	for (const fetchedFile of fetchedFiles) {
		if (!isRecord(fetchedFile) || typeof fetchedFile.name !== "string" || fetchedByBasename.has(fetchedFile.name)) {
			return ["files"]
		}
		fetchedByBasename.set(fetchedFile.name, fetchedFile)
	}

	if (fetchedByBasename.size !== contents.length || contents.some((file) => !fetchedByBasename.has(file.basename))) {
		return ["files"]
	}

	const mismatches: string[] = []
	for (const [index, file] of contents.entries()) {
		const fetched = fetchedByBasename.get(file.basename)!
		const fetchedChecksum = isRecord(fetched.checksum) ? fetched.checksum : undefined
		const expectsPrimary = index === 0
		if (
			(fetched.external_url !== undefined && fetched.external_url !== null) ||
			fetched.size !== file.content.byteLength ||
			fetchedChecksum?.sha256 !== file.sha256 ||
			(expectsPrimary ? fetched.is_primary !== true : fetched.is_primary !== false)
		) {
			mismatches.push(`file "${file.basename}"`)
		}
	}

	return mismatches
}

function isSameStringSet(value: unknown, expected: string[]): boolean {
	if (!Array.isArray(value) || value.length !== expected.length || !value.every((item) => typeof item === "string")) {
		return false
	}
	const actualSet = new Set(value)
	return actualSet.size === expected.length && expected.every((item) => actualSet.has(item))
}

function isSameDependencies(value: unknown, expected: unknown[]): boolean {
	if (!Array.isArray(value)) {
		return false
	}

	const actual = canonicalizeDependencyList(value)
	const expectedCanonical = canonicalizeDependencyList(expected)
	return actual !== undefined && actual === expectedCanonical
}

function canonicalizeDependencyList(dependencies: unknown[]): string | undefined {
	const canonicalDependencies: string[] = []
	for (const dependency of dependencies) {
		const canonicalDependency = canonicalizeJson(dependency)
		if (canonicalDependency === undefined) {
			return undefined
		}
		canonicalDependencies.push(canonicalDependency)
	}

	return `[${canonicalDependencies.sort().join(",")}]`
}

function canonicalizeJson(value: unknown): string | undefined {
	if (value === null) {
		return "null"
	}

	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value)
	}

	if (typeof value === "number") {
		return Number.isFinite(value) ? JSON.stringify(value) : undefined
	}

	if (Array.isArray(value)) {
		const canonicalItems: string[] = []
		for (const item of value) {
			const canonicalItem = canonicalizeJson(item)
			if (canonicalItem === undefined) {
				return undefined
			}
			canonicalItems.push(canonicalItem)
		}
		return `[${canonicalItems.join(",")}]`
	}

	if (!isRecord(value)) {
		return undefined
	}

	const canonicalEntries: string[] = []
	for (const key of Object.keys(value).sort()) {
		const canonicalValue = canonicalizeJson(value[key])
		if (canonicalValue === undefined) {
			return undefined
		}
		canonicalEntries.push(`${JSON.stringify(key)}:${canonicalValue}`)
	}
	return `{${canonicalEntries.join(",")}}`
}

function createUploadFormData(versionData: VersionData, contents: UploadFileContent[]) {
	const formData = new FormData()
	formData.append("data", JSON.stringify(versionData))

	for (const file of contents) {
		formData.append(file.basename, new Blob([new Uint8Array(file.content)]), file.basename)
	}

	return formData
}

function getCreateVersionUrl(apiBaseUrl: string, projectId: string) {
	return `${apiBaseUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(projectId)}/versions`
}

function getVersionUrl(apiBaseUrl: string, projectId: string, version: string) {
	return `${getCreateVersionUrl(apiBaseUrl, projectId)}/${encodeURIComponent(version)}`
}

function isRetryableFailure(error: unknown) {
	return error instanceof RetryableUploadError
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function parseApiResponse(response: Response): Promise<ApiResponse> {
	let text: string
	try {
		text = await response.text()
	} catch (error) {
		throw new RetryableUploadError(`Unable to read API response: ${getErrorMessage(error)}`, { cause: error })
	}

	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error("API response was not valid JSON.")
	}

	if (!isRecord(body)) {
		throw new Error("API response was malformed.")
	}

	return body
}

function getApiCode(body: ApiResponse) {
	if (typeof body.code === "number" && Number.isFinite(body.code)) {
		return body.code
	}

	if (typeof body.code === "string" && body.code.trim()) {
		const parsedCode = Number(body.code)
		if (Number.isFinite(parsedCode)) {
			return parsedCode
		}
	}

	return undefined
}

function getVersionId(body: ApiResponse) {
	if (!isRecord(body.data) || typeof body.data.id !== "string" || !body.data.id.trim()) {
		return undefined
	}

	return body.data.id
}

function getApiFailureMessage(response: Response, body: ApiResponse, apiCode: number | undefined) {
	const reason = !response.ok
		? `API request failed with HTTP ${response.status}`
		: body.code !== 0
			? "API returned an unsuccessful response"
			: "API response was malformed"
	const code = apiCode === undefined ? "" : ` (code ${apiCode})`
	const message = typeof body.message === "string" && body.message ? `: ${body.message}` : ""
	return `${reason}${code}${message}`
}

function getSiteRoot(apiBaseUrl: string) {
	return apiBaseUrl.replace(/\/api\/?$/, "")
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : "Unexpected action failure"
}

function isRecord(value: unknown): value is ApiResponse {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (process.env.NODE_ENV !== "test") {
	void run()
}
