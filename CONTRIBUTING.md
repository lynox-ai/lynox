# Contributing to lynox

Thanks for your interest in contributing to lynox.

## Getting Started

```bash
git clone https://github.com/lynox-ai/lynox.git
cd lynox
pnpm install
pnpm run dev
```

Requirements: Node.js 22+.

## Development Workflow

```bash
pnpm run dev          # Watch mode with hot reload
pnpm run typecheck    # tsc --noEmit — must pass with zero errors
pnpm run lint         # eslint src/ — must pass with zero errors
pnpm run build        # tsc → dist/
npx vitest run        # 113 files / ~2834 tests — all must pass
pnpm run coverage     # coverage report (CI enforces ≥65% lines, ≥60% functions, ≥50% branches, ≥65% statements)
```

Run a single test file:

```bash
npx vitest run src/core/memory.test.ts
```

### Git hooks

lynox uses [lefthook](https://github.com/evilmartians/lefthook) for pre-commit (typecheck) and pre-push (secret scanning via [gitleaks](https://github.com/gitleaks/gitleaks)). Install both before contributing:

```bash
brew install lefthook gitleaks
```

Hooks are auto-installed by `pnpm install` via the `prepare` script.

## Code Standards

- **ESM-only** — All imports use `.js` extensions
- **TypeScript strict mode** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`
- **Zero `any`** — Use `unknown` plus type narrowing (catch variables are `unknown`)
- **ESLint enforced** — `pnpm run lint` must pass. Rules in `eslint.config.js`: no-explicit-any, no-floating-promises, consistent-type-imports, no-unused-vars, eqeqeq, no-console, no-eval
- **Single type source** — All types live in `src/types/index.ts`
- **Co-located tests** — `*.test.ts` next to source files

## Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Ensure `pnpm run typecheck`, `pnpm run lint`, and `npx vitest run` pass
5. Open a PR with a clear description of what and why

Keep PRs focused — one concern per PR.

## Commit Messages

- English, imperative mood: "Add ...", "Fix ...", "Update ..."
- First line under 70 characters
- Reference issues where applicable

## Understanding the Codebase

See [Extension Points](https://docs.lynox.ai/developers/extension-points/) and the [HTTP API](https://docs.lynox.ai/developers/http-api/) reference for technical details.

## Reporting Bugs

Open a [GitHub issue](https://github.com/lynox-ai/lynox/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [Elastic License 2.0](LICENSE).
