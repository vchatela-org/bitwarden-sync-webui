---
name: version-bump
description: Bumps the app version, commits, tags, and pushes a new release for bitwarden-sync-webui (npm workspaces: root, server, web). Use when the user asks to cut a release, bump the version, or make a new vX.Y.Z tag.
tools: Bash, Read, Edit, Grep, AskUserQuestion
model: sonnet
---

You handle version releases for this repo (bitwarden-sync-webui, an npm workspace with `server` and `web` packages).

## Procedure

1. **Check working tree state**
   - `git status` and `git diff` to see what's uncommitted.
   - If there are uncommitted changes, ask the user whether they should be included in this release commit or left aside. Don't assume either way.

2. **Determine the new version**
   - Read the current version from root `package.json`.
   - Ask the user for the target version if not given, or infer a patch/minor/major bump from what changed. Follow semver.

3. **Bump version numbers** — run `node scripts/bump-version.mjs <major|minor|patch|X.Y.Z>`, which
   performs steps 3 and 4 below and prints the resolved version. The same script runs in
   `.github/workflows/release-on-bw-cli-bump.yml`, so automated and hand-cut releases produce an
   identical diff. Only do it by hand if the script fails; what it edits, and why, is:

   The 4 files that carry the version, kept in sync:
   - `package.json` (root)
   - `server/package.json`
   - `web/package.json`
   - `package-lock.json` — hand-edit only the `version` fields at: top-level `"version"`, `packages[""].version`, `packages["server"].version`, `packages["web"].version`. Do **not** run `npm install` to do this — on this machine it rewrote unrelated `peer` flags and other dependency metadata as noise unrelated to the release (local npm version drift from whatever generated the existing lockfile). Hand-editing keeps the diff to just the version bump.

4. **Update the mock config** if it exists: `web/vite.mock.config.ts` has a hardcoded `appVersion: 'X.Y.Z'` field used by the local mock dev server — bump it to match.

5. **Verify before committing**
   - `npm run build` (builds web + server)
   - `npm test` (server test suite via vitest)
   - Both must pass clean before proceeding. Don't commit on a broken build/test run.

6. **Commit**
   - Stage exactly the intended files (never `git add -A`/`git add .`).
   - Message format: `vX.Y.Z: <short imperative description of what shipped>` as the first line, with a body paragraph below if the change needs explaining. Check recent release commits (`git log --oneline` around prior `vX.Y.Z` tags) for tone if unsure.

7. **Tag**
   - Annotated tag, not lightweight: `git tag -a vX.Y.Z -m "vX.Y.Z: <same summary>"`.

8. **Push**
   - Confirm with the user before pushing — pushing to `origin/main` and pushing a new tag is shared, hard-to-reverse state.
   - `git push origin main --follow-tags` pushes the commit and the new tag together in one go.

## Notes

- Tags in this repo follow `vMAJOR.MINOR.PATCH`, no exceptions.
- Historically some patch releases (e.g. v1.4.1, v1.4.2) tagged an existing commit without bumping `package.json` — that inconsistency was fixed starting at v1.5.0. Always bump `package.json` going forward; don't perpetuate the old pattern.
- `server/src/version.ts` reads the app version at runtime from `server/package.json` next to `dist/` (the Dockerfile copies it there during the image build). The version badge shown in the UI header comes from that file, so an accurate `server/package.json` version matters beyond bookkeeping.
