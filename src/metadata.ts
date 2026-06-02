import { detectMinecraftVersions, detectPlatforms, isSupportedPlatform, Platform } from "./detect"
import { ActionInputs } from "./inputs"

export type ResolvedUploadFile = {
	basename: string
	path: string
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

export async function buildProjectVersionData(
	inputs: ActionInputs,
	files: ResolvedUploadFile[],
): Promise<CreateProjectVersionData> {
	const data: CreateProjectVersionData = {
		channel: inputs.channel,
		version: inputs.version,
		name: inputs.name,
		files: files.map((file) => file.basename),
	}

	if (inputs.changelog) {
		data.changelog = inputs.changelog
	}

	const minecraftVersions = resolveMinecraftVersions(inputs, files)
	if (minecraftVersions.length) {
		data.minecraft_versions = minecraftVersions
	}

	const platforms = await resolvePlatforms(inputs, files)
	if (platforms.length) {
		data.platforms = platforms
	}

	if (inputs.dependencies?.length) {
		data.dependencies = inputs.dependencies
	}

	validateProjectVersionData(data)
	return data
}

function resolveMinecraftVersions(inputs: ActionInputs, files: ResolvedUploadFile[]) {
	if (inputs.minecraftVersions?.length) {
		return dedupe(inputs.minecraftVersions)
	}

	if (!inputs.autoDetectMinecraft) {
		return []
	}

	return detectMinecraftVersions(files)
}

async function resolvePlatforms(inputs: ActionInputs, files: ResolvedUploadFile[]) {
	if (inputs.platforms?.length) {
		return validatePlatforms(dedupe(inputs.platforms))
	}

	if (!inputs.autoDetectPlatform) {
		return []
	}

	return detectPlatforms(files)
}

function validateProjectVersionData(data: CreateProjectVersionData) {
	validateString(data.channel, "channel", 1, 32, slugRegex)
	validateString(data.version, "version", 1, 32, urlSafeRegex)
	validateString(data.name, "name", 1, 64, visibleCharsRegex)

	if (data.changelog !== undefined) {
		validateString(data.changelog, "changelog", 0, 1000)
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
