# Contributing

## Development Setup

```bash
npm ci
npm run test:ci
```

## Code Style

- Keep the public API small and stable.
- Put browser automation details behind services and the private engine.
- Do not expose selectors, cookies, pages, browser instances, or Puppeteer handles to applications.
- Add or update docs when public behavior changes.

## Tests

Unit and syntax checks:

```bash
npm run test:ci
```

Live browser smoke test:

```bash
npm run test:live
```

Live send behavior requires explicit opt-in:

```bash
SNAPCHAT_LIVE_SEND=1 SNAPCHAT_SNAP_FRIEND_IDS=id1,id2 npm run test:live
```

## Release

1. Update [CHANGELOG.md](CHANGELOG.md).
2. Run `npm run test:ci`.
3. Run `npm run pack:dry`.
4. Bump version with `npm run version:patch`, `npm run version:minor`, or `npm run version:major`.
5. Publish with `npm publish`.
