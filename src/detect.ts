import { promises as fs } from "node:fs"

export type DetectableFile = {
	basename: string
	path?: string
}

export type Platform = (typeof supportedPlatforms)[number]

const minecraftVersionRegex = /(?:^|[^0-9])(1\.\d+(?:\.\d+)?|(?:2[6-9]|[3-9]\d)\.[1-9]\d*(?:\.\d+)?)\b/g
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

export type FileMetadata = {
	isUsable: boolean
	minecraftVersions: string[]
	platforms: Platform[]
}

export async function detectFileMetadata(file: DetectableFile): Promise<FileMetadata> {
	const minecraftVersions = detectMinecraftVersions([file])

	if (!file.path) {
		return { isUsable: false, minecraftVersions, platforms: [] }
	}

	const entryNames = await readZipEntryNames(file.path)
	const platforms = new Set<Platform>()
	detectFilenamePlatforms(file.basename, platforms)
	if (entryNames) {
		detectDescriptorPlatformsFromEntries(entryNames, platforms)
	}
	return { isUsable: entryNames !== undefined, minecraftVersions, platforms: [...platforms] }
}

export function isSupportedPlatform(platform: string): platform is Platform {
	return supportedPlatforms.includes(platform as Platform)
}

async function detectJarDescriptorPlatforms(file: DetectableFile, platforms: Set<Platform>) {
	if (!file.path || !file.basename.toLowerCase().endsWith(".jar")) {
		return
	}

	const entryNames = await readZipEntryNames(file.path)
	detectDescriptorPlatformsFromEntries(entryNames ?? [], platforms)
}

function detectDescriptorPlatformsFromEntries(entryNames: string[], platforms: Set<Platform>) {
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

const centralDirectoryWindowSize = 128 * 1024

async function readZipEntryNames(filePath: string): Promise<string[] | undefined> {
	// The ZIP central directory lives at the end of the file; read only a tail
	// window instead of loading the whole archive into memory.
	try {
		const handle = await fs.open(filePath, "r")
		try {
			const { size } = await handle.stat()
			const windowSize = Math.min(size, centralDirectoryWindowSize)
			const windowStart = size - windowSize
			const buffer = Buffer.alloc(windowSize)
			await handle.read(buffer, 0, windowSize, windowStart)
			const entryNames = readEntryNamesFromWindow(buffer, windowStart)
			if (entryNames) {
				return entryNames
			}
		} finally {
			await handle.close()
		}
	} catch {
		return undefined
	}

	// The central directory extends beyond the read window (rare, huge
	// archives); fall back to reading the whole file.
	try {
		return readEntryNamesFromWindow(await fs.readFile(filePath), 0)
	} catch {
		return undefined
	}
}

function readEntryNamesFromWindow(buffer: Buffer, windowStart: number): string[] | undefined {
	const centralDirectory = findCentralDirectory(buffer)
	if (!centralDirectory || centralDirectory.offset < windowStart) {
		return undefined
	}

	const entryNames: string[] = []
	let offset = centralDirectory.offset - windowStart
	const centralDirectoryEnd = offset + centralDirectory.size
	if (centralDirectoryEnd > buffer.length) {
		return undefined
	}

	for (let entry = 0; entry < centralDirectory.entries; entry += 1) {
		if (offset + 46 > centralDirectoryEnd) {
			return undefined
		}
		if (buffer.readUInt32LE(offset) !== zipCentralDirectorySignature) {
			return undefined
		}

		const fileNameLength = buffer.readUInt16LE(offset + 28)
		const extraFieldLength = buffer.readUInt16LE(offset + 30)
		const commentLength = buffer.readUInt16LE(offset + 32)
		const fileNameStart = offset + 46
		const fileNameEnd = fileNameStart + fileNameLength

		const entryEnd = fileNameEnd + extraFieldLength + commentLength
		if (entryEnd > centralDirectoryEnd) {
			return undefined
		}

		entryNames.push(buffer.subarray(fileNameStart, fileNameEnd).toString("utf8"))
		offset = entryEnd
	}

	return offset === centralDirectoryEnd ? entryNames : undefined
}

function findCentralDirectory(buffer: Buffer): { entries: number; offset: number; size: number } | undefined {
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
			size: buffer.readUInt32LE(offset + 12),
		}
	}

	return undefined
}
