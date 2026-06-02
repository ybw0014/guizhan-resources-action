# Guizhan Resources Upload Action

A GitHub Action for uploading built artifacts to [Guizhan Resources](https://resources.guizhanss.com).

## Quick start

```yaml
- uses: ybw0014/guizhan-resources-action@v1
  with:
    token: ${{ secrets.GUIZHAN_TOKEN }}
    project-id: my-project
    channel: releases
    files: build/libs/*.jar
```

## Documentation

- [English documentation](https://docs.resources.guizhanss.com/actions/guizhan-resources-action/)
- [中文文档](https://docs.resources.guizhanss.com/zh-cn/actions/guizhan-resources-action/)

## License

MIT