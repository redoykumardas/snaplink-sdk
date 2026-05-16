# Versioning and Releases

`@redoykumardas/snaplink-sdk` uses Semantic Versioning.

## Version Format

```txt
MAJOR.MINOR.PATCH
```

- `PATCH`: bug fixes, selector hardening, documentation updates, internal reliability improvements.
- `MINOR`: new public methods, new options, backward-compatible feature additions.
- `MAJOR`: breaking public API changes, changed return shapes, removed options, changed runtime requirements.

## Current Version

The current package version is stored in [package.json](../package.json).

## Release Checklist

1. Update code and docs.
2. Add an entry to [CHANGELOG.md](../CHANGELOG.md).
3. Run checks:

```bash
npm run test:ci
npm run pack:dry
```

4. Bump the version:

```bash
npm run version:patch
```

Use `version:minor` or `version:major` when appropriate.

5. Publish manually:

```bash
npm publish --access public
```

Or publish through GitHub:

1. Create an npm automation token.
2. Add it to GitHub repository secrets as `NPM_TOKEN`.
3. Push the version commit and tag.
4. Create a GitHub Release for that tag.

The `.github/workflows/publish.yml` workflow runs checks and publishes the package to npm.

## Live Verification

Live verification is intentionally separate from CI because it opens a real browser and can interact with a real account:

```bash
npm run test:live
```

Real sending requires explicit opt-in:

```bash
SNAPCHAT_LIVE_SEND=1 SNAPCHAT_SNAP_FRIEND_IDS=id1,id2 npm run test:live
```

Never enable live-send checks in general CI.
