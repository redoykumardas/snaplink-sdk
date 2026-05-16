# SnapLink SDK Architecture

`@redoykumardas/snaplink-sdk` exposes a small public Node.js API and hides browser automation behind internal services.

```txt
Application
  -> SnapchatClient
  -> Feature Services
  -> AutomationEngine
  -> Private Snapchat browser engine
  -> Puppeteer Extra + Stealth
  -> Snapchat Web
```

## Public API

Applications should import only from `src/index.js` or the package root after publishing:

```js
import { SnapchatClient } from "@redoykumardas/snaplink-sdk";
```

Public methods:

- `init(config)`
- `login(credentials)`
- `logout()`
- `isLoggedIn()`
- `getFriends(options)`
- `getFriendStatus(options)`
- `sendMessage(friendId, message, options)`
- `getConversation(friendId)`
- `watchMessages(options)`
- `sendSnap(options)`
- `close()`

Detailed usage examples are in [../api.md](../api.md).

## Module Boundaries

- `src/SnapchatClient.js` is the public facade.
- `src/core/AutomationEngine.js` owns browser runtime, configuration, debug tools, and the private browser engine instance.
- `src/modules/auth` owns login, logout, login state, and automatic session persistence.
- `src/modules/friends` owns dynamic friend retrieval and virtualized-list access.
- `src/modules/chat` owns internal chat opening, current-chat caching, sending messages, and reading conversations.
- `src/modules/watch` owns message detection, event queueing, deduplication, and fallback polling.
- `src/modules/status` owns friend message status extraction.
- `src/modules/snaps` owns capture/send snap workflows.
- `src/shared` owns selectors, logging, config defaults, debug screenshots, and typed SDK errors.

## Migration Notes

`src/core/PrivateSnapchatEngine.js` currently contains the low-level browser automation engine. Future hardening should move pieces from that engine into focused services incrementally:

1. Move selectors into `src/shared/selectors`.
2. Move virtual-list logic into a reusable `VirtualListScroller`.
3. Move login state detection into `StateMonitor`.
4. Move cookie file paths behind an internal session store owned by `AutomationEngine` and `AuthService`.
5. Keep `SnapchatClient` stable while internals evolve.

This gives apps a stable SDK contract while the automation internals can keep improving.

## Publish Boundary

Published package contents are controlled by the `files` field in `package.json`.
Generated screenshots, cookie files, `.env`, local browser profiles, and live-test artifacts are intentionally excluded.
