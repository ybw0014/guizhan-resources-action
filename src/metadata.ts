import * as core from "@actions/core"

import { detectFileMetadata, isSupportedPlatform, Platform } from "./detect"
import { ActionInputs } from "./inputs"

export type ResolvedUploadFile = {
	basename: string
	path: string
	metadata?: DetectedFileMetadata
}

export type CreateProjectVersionData = {
	channel: string
	version: string
	name: string
	changelog?: string
	minecraft_versions?: string[]
	platforms?: Platform[]
	dependencies?: unknown[]
	files: string[]
}

const slugRegex = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i
const urlSafeRegex = /^[a-zA-Z0-9!@$()`.+,_"-]*$/
const visibleCharsRegex = /^[^\p{Cc}\p{Cf}]+$/u
const minecraftVersionRegex = /^(?:1\.\d+(?:\.\d+)?|(?:2[6-9]|[3-9]\d)\.[1-9]\d*(?:\.\d+)?)$/
const fileNameRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9\s_\-()]|\.(?!\.))*[a-zA-Z0-9)]\.[a-zA-Z0-9]+$/
const maxPlatforms = 10

type DetectedFileMetadata = Awaited<ReturnType<typeof detectFileMetadata>>

export async function buildProjectVersionData(
	inputs: ActionInputs,
	files: ResolvedUploadFile[],
): Promise<{ data: CreateProjectVersionData; files: ResolvedUploadFile[] }> {
	const usableFiles = await resolveUsableFiles(inputs, files)
	const data: CreateProjectVersionData = {
		channel: inputs.channel,
		version: inputs.version,
		name: inputs.name,
		files: usableFiles.map((file) => file.basename),
	}

	if (inputs.changelog) {
		data.changelog = inputs.changelog
	}

	const minecraftVersions = resolveMinecraftVersions(inputs, usableFiles)
	if (minecraftVersions.length) {
		data.minecraft_versions = minecraftVersions
	}

	const platforms = resolvePlatforms(inputs, usableFiles)
	if (platforms.length) {
		data.platforms = platforms
	}

	if (inputs.dependencies?.length) {
		data.dependencies = inputs.dependencies
	}

	validateProjectVersionData(data)
	return { data, files: usableFiles }
}

async function resolveUsableFiles(inputs: ActionInputs, files: ResolvedUploadFile[]) {
	const needsDetection =
		(inputs.autoDetectMinecraft && !inputs.minecraftVersions?.length) ||
		(inputs.autoDetectPlatform && !inputs.platforms?.length)
	if (!needsDetection) {
		return files
	}

	const usableFiles: ResolvedUploadFile[] = []
	for (const file of files) {
		const metadata = await detectFileMetadata(file)
		const hasDetectedMetadata = metadata.minecraftVersions.length > 0 || metadata.platforms.length > 0
		if (metadata.isUsable && hasDetectedMetadata) {
			usableFiles.push({ ...file, metadata })
			continue
		}

		if (inputs.failMode === "fail") {
			throw new Error(`Unable to detect metadata for "${file.basename}".`)
		}
		if (inputs.failMode === "warn") {
			core.warning(`Unable to detect metadata for "${file.basename}"; uploading without detected metadata from this file.`)
			usableFiles.push({ ...file, metadata })
		}
	}

	return usableFiles
}

function resolveMinecraftVersions(inputs: ActionInputs, files: ResolvedUploadFile[]) {
	if (inputs.minecraftVersions?.length) {
		return dedupe(inputs.minecraftVersions)
	}

	if (!inputs.autoDetectMinecraft) {
		return []
	}

	return files.flatMap((file) => file.metadata?.minecraftVersions ?? [])
}

function resolvePlatforms(inputs: ActionInputs, files: ResolvedUploadFile[]) {
	if (inputs.platforms?.length) {
		return validatePlatforms(dedupe(inputs.platforms))
	}

	if (!inputs.autoDetectPlatform) {
		return []
	}

	return files.flatMap((file) => file.metadata?.platforms ?? [])
}

function validateProjectVersionData(data: CreateProjectVersionData) {
	validateString(data.channel, "channel", 1, 38, slugRegex)
	validateString(data.version, "version", 1, 32, urlSafeRegex)
	validateString(data.name, "name", 1, 64, visibleCharsRegex)

	if (data.changelog !== undefined) {
		validateString(data.changelog, "changelog", 0, 10000)
	}

	if (data.minecraft_versions) {
		for (const minecraftVersion of data.minecraft_versions) {
			validateString(minecraftVersion, "minecraft_versions", 1, Number.POSITIVE_INFINITY, minecraftVersionRegex)
		}
	}

	if (data.platforms) {
		validatePlatforms(data.platforms)
	}

	if (data.dependencies !== undefined && !Array.isArray(data.dependencies)) {
		throw new Error('Field "dependencies" must be an array.')
	}

	if (!data.files.length) {
		throw new Error('Field "files" must include at least one file.')
	}

	for (const file of data.files) {
		validateString(file, "files", 1, 128, fileNameRegex)
	}
}

function validatePlatforms(platforms: string[]): Platform[] {
	if (platforms.length > maxPlatforms) {
		throw new Error(`Field "platforms" must include at most ${maxPlatforms} platforms.`)
	}

	const validatedPlatforms: Platform[] = []
	for (const platform of platforms) {
		if (!isSupportedPlatform(platform)) {
			throw new Error(`Unsupported platform "${platform}".`)
		}
		validatedPlatforms.push(platform)
	}

	return validatedPlatforms
}

function validateString(value: string, fieldName: string, minLength: number, maxLength: number, regex?: RegExp) {
	if (value.length < minLength || value.length > maxLength) {
		throw new Error(`Field "${fieldName}" has an invalid length.`)
	}

	if (regex && !regex.test(value)) {
		throw new Error(`Field "${fieldName}" has an invalid value.`)
	}
}

function dedupe<T>(items: T[]): T[] {
	return [...new Set(items)]
}
