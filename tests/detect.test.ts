import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { detectMinecraftVersions, detectPlatforms } from "../src/detect"

let tempDir: string

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "guizhan-action-detect-"))
})

afterEach(async () => {
	await fs.rm(tempDir, { force: true, recursive: true })
})

describe("detectMinecraftVersions", () => {
	it("detects and dedupes Minecraft versions from resolved basenames", () => {
		const versions = detectMinecraftVersions([
			{ basename: "Plugin-1.20.4-paper.jar" },
			{ basename: "Plugin-1.20.4-docs.zip" },
			{ basename: "Legacy_1.7.10.jar" },
			{ basename: "Unsupported-1.6.4.jar" },
		])

		expect(versions).toEqual(["1.20.4", "1.7.10"])
	})

	it("returns an empty array when no Minecraft versions are detected", () => {
		expect(detectMinecraftVersions([{ basename: "Plugin.jar" }])).toEqual([])
	})
})

describe("detectPlatforms", () => {
	it("detects and dedupes platforms from JAR descriptors and filenames", async () => {
		const paperJar = await writeJar("Plugin-1.20.4-paper.jar", ["paper-plugin.yml"])
		const bukkitJar = await writeJar("Plugin-spigot.jar", ["plugin.yml"])
		const foliaZip = path.join(tempDir, "Plugin-folia.zip")
		await fs.writeFile(foliaZip, "not a jar")

		const platforms = await detectPlatforms([
			{ basename: "Plugin-1.20.4-paper.jar", path: paperJar },
			{ basename: "Plugin-spigot.jar", path: bukkitJar },
			{ basename: "Plugin-folia.zip", path: foliaZip },
		])

		expect(platforms).toEqual(["paper", "bukkit", "spigot", "folia"])
	})

	it("returns an empty array when no platforms are detected", async () => {
		const jarPath = await writeJar("Plugin.jar", ["META-INF/MANIFEST.MF"])

		await expect(detectPlatforms([{ basename: "Plugin.jar", path: jarPath }])).resolves.toEqual([])
	})
})

async function writeJar(fileName: string, entries: string[]) {
	const filePath = path.join(tempDir, fileName)
	await fs.writeFile(filePath, createZip(entries))
	return filePath
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
