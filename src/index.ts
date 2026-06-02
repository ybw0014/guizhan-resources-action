import * as core from "@actions/core"

export function getScaffoldMessage() {
  return "Guizhan Resources upload action scaffold is ready."
}

export async function run() {
  core.info(getScaffoldMessage())
  core.setOutput("version-id", "")
  core.setOutput("version-url", "")
  core.setOutput("uploaded-files", "")
  core.setOutput("api-code", "")
}

if (process.env.NODE_ENV !== "test") {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected action failure"
    core.setFailed(message)
  })
}
