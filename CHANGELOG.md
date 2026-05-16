# Changelog

All notable changes to this package are documented here.

This project follows Semantic Versioning.

## 1.0.0 - 2026-05-17

### Added

- Public `SnapchatClient` SDK facade.
- Grouped `api.auth`, `api.friends`, `api.messaging`, `api.snap`, and `api.browser` modules.
- Automatic session restore and cookie save through `session.key`.
- Internal chat opening for `sendMessage()` and `getConversation()`.
- Dynamic friend loading with virtualized-list scrolling.
- Friend status extraction.
- Conversation extraction.
- Message watching with sidebar mutation detection, queueing, deduplication, and fallback polling.
- Image snap creation with caption support.
- Multi-friend snap sending through `friendIds`, `friends`, and array `recipients`.
- Shortcut and target-based snap sending.
- Live smoke test runner.
- TypeScript declaration file.
- CI workflow and publish checks.

### Changed

- Removed application-facing `openChat()`, `saveCookies()`, `loadCookies()`, and popup methods from the public API.
- Moved browser automation behind `PrivateSnapchatEngine`.

### Removed

- Old loose documentation files and generated debug/cookie artifacts from the package folder.
