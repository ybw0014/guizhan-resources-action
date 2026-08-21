# Guizhan Resources Upload Action

A GitHub Action for uploading built artifacts to [Guizhan Resources](https://resources.guizhanss.com).

## Quick start

```yaml
- uses: ybw0014/guizhan-resources-action@v0
  with:
    token: ${{ secrets.GUIZHAN_TOKEN }}
    project: my-project
    channel: releases
    files: build/libs/*.jar
```

## Features

- Uploads `.jar`/`.zip` files from local paths, glob patterns, or GitHub Actions artifacts.
- Auto-detects Minecraft versions (including year-based versions such as `26.1`) and platforms from file names and JAR descriptors.
- Retries transient failures (network errors and HTTP 5xx) with linear backoff. `retry-attempts` (default `2`) is the total number of attempts; `retry-delay` (default `1000` ms) scales by attempt number.
- Idempotent replay: if the API reports that the version already exists (code `5301`), the action fetches the existing version and treats it as success only when its metadata, dependencies, and file checksums match this request exactly.
- `fail-mode` (`fail`/`warn`/`skip`) controls what happens when a matched file cannot be parsed or yields no detected metadata.
- Glob/artifact expansion skips unrelated sidecar files (`.sha1`, `.sha256`, `.md5`, `.md`, `.txt`, `.json`) and deduplicates paths; literal file paths are never filtered.
- `changelog-file` reads the changelog from a file (mutually exclusive with `changelog`).

Outputs: `version-id`, `version-url`, `uploaded-files`, and `api-code` (normalized result code — `0` means success, including a verified idempotent replay).

## Documentation

- [Documentation](https://docs.resources.guizhanss.com/actions/upload/)
- [中文文档](https://docs.resources.guizhanss.com/zh-cn/actions/upload/)

## License

MIT
