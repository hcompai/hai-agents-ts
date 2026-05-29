# Contributing

The client code under `packages/sdk/src/` is generated and should not be
hand-edited — changes there are overwritten when the SDK is next published. For
SDK behavior or API coverage, open an issue describing what you need.

Hand-written parts of this repo (packaging, build config, docs) are open to
PRs. For anything non-trivial, open an issue first.

## Dev setup

```bash
git clone https://github.com/hcompai/hai-agents-ts && cd hai-agents-ts
pnpm install
```

## Checks

```bash
pnpm -r run typecheck
pnpm -r run build
```
