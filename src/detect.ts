import { promises as fs } from "node:fs"

export type DetectableFile = {
	basename: string
	path?: string
}

export type Platform = (typeof supportedPlatforms)[number]

const minecraftVersionRegex = /(?:^|[^0-9])((?:1\.(?:[7-9]|[1-2][0-9])(?:\.\d+)?))\b/g
const zipEndOfCentralDirectorySignature = 0x06054b50
const zipCentralDirectorySignature = 0x02014b50

export const supportedPlatforms = [
	"bukkit",
	"spigot",
	"paper",
	"folia",
	"purpur",
	"forge",
	"fabric",
	"quilt",
	"neoforge",
	"resourcepack",
	"datapack",
	"other",
] as const

export function detectMinecraftVersions(files: DetectableFile[]): string[] {
	const versions = new Set<string>()

	for (const file of files) {
		for (const match of file.basename.matchAll(minecraftVersionRegex)) {
			versions.add(match[1])
		}
	}

	return [...versions]
}

export async function detectPlatforms(files: DetectableFile[]): Promise<Platform[]> {
	const platforms = new Set<Platform>()

	for (const file of files) {
		await detectJarDescriptorPlatforms(file, platforms)
		detectFilenamePlatforms(file.basename, platforms)
	}

	return [...platforms]
}

export function isSupportedPlatform(platform: string): platform is Platform {
	return supportedPlatforms.includes(platform as Platform)
}

async function detectJarDescriptorPlatforms(file: DetectableFile, platforms: Set<Platform>) {
	if (!file.path || !file.basename.toLowerCase().endsWith(".jar")) {
		return
	}

	const entryNames = await readZipEntryNames(file.path)
	if (entryNames.some((entryName) => getZipEntryBasename(entryName) === "paper-plugin.yml")) {
		platforms.add("paper")
	}

	if (entryNames.some((entryName) => getZipEntryBasename(entryName) === "plugin.yml")) {
		platforms.add("bukkit")
	}
}

function detectFilenamePlatforms(basename: string, platforms: Set<Platform>) {
	const normalizedBasename = basename.toLowerCase()

	if (normalizedBasename.includes("folia")) {
		platforms.add("folia")
	}

	if (normalizedBasename.includes("paper")) {
		platforms.add("paper")
	}

	if (normalizedBasename.includes("spigot")) {
		platforms.add("spigot")
	}
}

function getZipEntryBasename(entryName: string) {
	const normalizedEntryName = entryName.replace(/\\/g, "/")
	return normalizedEntryName.slice(normalizedEntryName.lastIndexOf("/") + 1)
}

async function readZipEntryNames(filePath: string): Promise<string[]> {
	let buffer: Buffer
	try {
		buffer = await fs.readFile(filePath)
	} catch {
		return []
	}

	const centralDirectory = findCentralDirectory(buffer)
	if (!centralDirectory) {
		return []
	}

	const entryNames: string[] = []
	let offset = centralDirectory.offset

	for (let entry = 0; entry < centralDirectory.entries && offset + 46 <= buffer.length; entry += 1) {
		if (buffer.readUInt32LE(offset) !== zipCentralDirectorySignature) {
			break
		}

		const fileNameLength = buffer.readUInt16LE(offset + 28)
		const extraFieldLength = buffer.readUInt16LE(offset + 30)
		const commentLength = buffer.readUInt16LE(offset + 32)
		const fileNameStart = offset + 46
		const fileNameEnd = fileNameStart + fileNameLength

		if (fileNameEnd > buffer.length) {
			break
		}

		entryNames.push(buffer.subarray(fileNameStart, fileNameEnd).toString("utf8"))
		offset = fileNameEnd + extraFieldLength + commentLength
	}

	return entryNames
}

function findCentralDirectory(buffer: Buffer): { entries: number; offset: number } | undefined {
	const minEndOfCentralDirectorySize = 22
	const maxCommentSize = 65_535
	const searchStart = Math.max(0, buffer.length - minEndOfCentralDirectorySize - maxCommentSize)

	for (let offset = buffer.length - minEndOfCentralDirectorySize; offset >= searchStart; offset -= 1) {
		if (buffer.readUInt32LE(offset) !== zipEndOfCentralDirectorySignature) {
			continue
		}

		return {
			entries: buffer.readUInt16LE(offset + 10),
			offset: buffer.readUInt32LE(offset + 16),
		}
	}

	return undefined
}
