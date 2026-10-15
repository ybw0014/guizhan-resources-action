import { DefaultArtifactClient } from "@actions/artifact"
import * as glob from "@actions/glob"
import { mkdtemp, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { fileNameRegex, isWithinFilenameByteLimit, windowsDeviceNameRegex } from "./filename"
import { ActionInputs } from "./inputs"

const allowedExtensions = new Set([".jar", ".zip"])
// Non-artifact sidecar files commonly found in build directories and
// downloaded artifacts. Only filtered from glob/artifact expansion;
// literal file paths are still validated strictly.
const unrelatedExtensions = new Set([".sha1", ".sha256", ".md5", ".md", ".txt", ".json"])
const globMagicRegex = /[*?[\]!{}]/

export type ResolvedUploadFile = {
  path: string
  basename: string
}

type ArtifactClient = Pick<DefaultArtifactClient, "listArtifacts" | "downloadArtifact">

export async function collectFiles(inputs: ActionInputs, artifactClient: ArtifactClient = new DefaultArtifactClient()) {
  const localFiles = await resolveLocalFiles(inputs.files)
  const artifactFiles = await resolveArtifactFiles(inputs.artifactNames, artifactClient)
  return finalizeFiles(dedupeFiles([...localFiles, ...artifactFiles]), inputs.primaryFile)
}

function dedupeFiles(files: ResolvedUploadFile[]): ResolvedUploadFile[] {
  const seenPaths = new Set<string>()
  return files.filter((file) => {
    if (seenPaths.has(file.path)) {
      return false
    }
    seenPaths.add(file.path)
    return true
  })
}

type ResolvedCandidate = {
  path: string
  isLiteral: boolean
}

async function resolveLocalFiles(patterns: string[]): Promise<ResolvedUploadFile[]> {
  const candidates: ResolvedCandidate[] = []

  for (const pattern of patterns) {
    const globber = await glob.create(pattern, { followSymbolicLinks: true })
    const matches = await globber.glob()

    if (!matches.length) {
      throw new Error(`File pattern "${pattern}" did not match any files.`)
    }

    const isLiteral = !globMagicRegex.test(pattern)
    candidates.push(...matches.map((filePath) => ({ path: filePath, isLiteral })))
  }

  return resolveCandidateFiles(candidates)
}

async function resolveArtifactFiles(
  artifactNames: string[],
  artifactClient: ArtifactClient
): Promise<ResolvedUploadFile[]> {
  if (!artifactNames.length) {
    return []
  }

  const { artifacts } = await artifactClient.listArtifacts({ latest: true })
  const candidates: ResolvedCandidate[] = []

  for (const artifactName of artifactNames) {
    const artifact = artifacts.find((item) => item.name === artifactName)
    if (!artifact) {
      throw new Error(`Artifact "${artifactName}" was not found in the current workflow run.`)
    }

    const downloadPath = await mkdtemp(path.join(tmpdir(), `guizhan-resources-${safeTempName(artifactName)}-`))
    await artifactClient.downloadArtifact(artifact.id, { path: downloadPath })
    candidates.push(
      ...(await collectFilesRecursively(downloadPath)).map((filePath) => ({ path: filePath, isLiteral: false }))
    )
  }

  return resolveCandidateFiles(candidates)
}

async function collectFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

async function resolveCandidateFiles(candidates: ResolvedCandidate[]) {
  const files: ResolvedUploadFile[] = []

  for (const candidate of candidates) {
    const absolutePath = path.resolve(candidate.path)
    const fileStat = await stat(absolutePath)

    if (fileStat.isDirectory()) {
      throw new Error(`Resolved path "${absolutePath}" is a directory. Only files can be uploaded.`)
    }

    if (!fileStat.isFile()) {
      throw new Error(`Resolved path "${absolutePath}" is not a regular file.`)
    }

    const basename = path.basename(absolutePath)
    if (!candidate.isLiteral && unrelatedExtensions.has(path.extname(basename).toLowerCase())) {
      continue
    }

    validateBasename(basename, absolutePath)
    files.push({ path: absolutePath, basename })
  }

  return files
}

function finalizeFiles(files: ResolvedUploadFile[], primaryFile: string | undefined) {
  const seenBasenames = new Map<string, string>()

  for (const file of files) {
    const existingPath = seenBasenames.get(file.basename)
    if (existingPath) {
      throw new Error(`Duplicate upload basename "${file.basename}" from "${existingPath}" and "${file.path}".`)
    }

    seenBasenames.set(file.basename, file.path)
  }

  const sorted = [...files].sort((left, right) => {
    const basenameCompare = left.basename.localeCompare(right.basename)
    return basenameCompare || left.path.localeCompare(right.path)
  })

  if (!primaryFile) {
    return sorted
  }

  const primaryIndex = sorted.findIndex((file) => file.basename === primaryFile)
  if (primaryIndex === -1) {
    throw new Error(`Primary file "${primaryFile}" was not found in resolved upload files.`)
  }

  const [primary] = sorted.splice(primaryIndex, 1)
  return [primary, ...sorted]
}

function validateBasename(basename: string, absolutePath: string) {
  if (
    basename.length > 128 ||
    !fileNameRegex.test(basename) ||
    windowsDeviceNameRegex.test(basename) ||
    !isWithinFilenameByteLimit(basename)
  ) {
    throw new Error(`Resolved file "${absolutePath}" has unsafe basename "${basename}".`)
  }

  const extension = path.extname(basename).toLowerCase()
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Resolved file "${absolutePath}" has unsupported extension "${extension}".`)
  }
}

function safeTempName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-")
}
