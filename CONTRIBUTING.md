# Contributing to lynox

Thanks for your interest in lynox! lynox is a small, focused project (one maintainer, three production deployments). Contributions are welcome within a deliberately narrow scope — see below.

## What we accept

| Type | Status | How to start |
|------|--------|--------------|
| **Bug reports** | Always welcome | [Open an issue](https://github.com/lynox-ai/lynox/issues) with repro steps, expected vs actual, Node version + OS |
| **Documentation fixes** | Always welcome | PR directly — typo fix, clarification, missing detail, expanded example |
| **Integration scaffolds** | Welcome | New OpenAI-compatible provider entry, new MCP server example, new docker-compose pattern. Open an issue first so we can pre-discuss the shape |
| **Test additions** | Welcome | Especially for edge cases we missed. Vitest, co-located `*.test.ts` |
| **Bench scenarios** | Welcome | New scenario in `core/scripts/set-bench/scenarios/` — must come with a deterministic pass-check |
| **Features** | Discuss first | Open an issue describing the use case + proposed approach BEFORE coding. A feature PR without a prior issue may be closed without review — not because the work is bad but because architectural fit is the bottleneck |
| **Refactors** | Discuss first | Same as features — open an issue with the motivation. Cosmetic refactors are usually declined; behaviour-preserving refactors that unblock a feature get reviewed |

## How you can help without writing code

- **Star + share.** Genuinely helps a solo-maintained project surface to people who have the same problem.
- **Report security vulnerabilities responsibly.** See [SECURITY.md](SECURITY.md).
- **Tell us where the docs are wrong.** Sometimes the answer is "open a PR with the fix"; sometimes it's "open an issue and we'll patch the docs".

## Internal development workflow

For maintainers + invited collaborators with write access:

1. Create a feature branch (`fix/...`, `feat/...`, `chore/...`)
2. Open a PR against `main` — CI runs lint, typecheck, tests, security scan, and the pre-push hook does gitleaks + pattern-scan + security-scan locally
3. All checks must pass before merge
4. After merge, a staging image builds automatically; production deploys are manual

`main` is protected: no force push, no direct push without CI passing. See the release strategy doc in the private pro repo for the full release process.

Releases are cut from `main` and tagged `v<major>.<minor>.<patch>`; the release tag pushes both the `@lynox-ai/core` npm package and the `ghcr.io/lynox-ai/lynox:vX.Y.Z` Docker image. See [`CHANGELOG.md`](CHANGELOG.md) for the per-version log.

## Why the narrow scope?

Three reasons honest about being solo-maintained:

1. **Reviewing a PR takes about as much time as writing the same change.** For docs and tests that's fine. For features, the architectural-fit review usually outweighs the code review — which is why an issue-first discussion saves both sides time.
2. **The architecture is still settling.** Some subsystems (orchestrator hooks, MCP client, calendar integration) are mid-refactor. Features that touch them will get rebased a lot.
3. **The project sustains through the Managed hosting tier**, not through community labour. That means the maintainer can afford to be deliberate about scope — but it also means there's no PR triage rota to pick up your contribution if I'm heads-down on the next release.

## License

lynox is licensed under the [Elastic License 2.0](LICENSE) — source-available, self-hostable, but not OSI-approved "open source". By contributing you agree to license your contribution under ELv2.

The one practical restriction: you can self-host lynox freely (including for clients, internal tools, and your own SaaS that uses lynox as one component), but you can't resell lynox itself as a competing managed-hosting service. The Managed tier exists to fund the project; if you want to host it for someone else, [talk to me](https://github.com/lynox-ai/lynox/issues).
