# SnapLink SDK

Private Snapchat Web automation SDK for Node.js applications.

`@redoykumardas/snaplink-sdk` provides a black-box API for Snapchat Web automation. Applications call high-level methods such as `init()`, `login()`, `getFriends()`, `sendMessage()`, `getConversation()`, and `sendSnap()`. Puppeteer, stealth setup, browser lifecycle, cookies, selectors, popups, virtualized scrolling, chat opening, retries, screenshots, and state monitoring stay inside the package.

## Status

- Package format: ESM
- Runtime: Node.js 20+
- Browser engine: Puppeteer + puppeteer-extra-plugin-stealth
- Types: bundled TypeScript declarations
- Versioning: SemVer, see [CHANGELOG.md](CHANGELOG.md)

## Install

```bash
npm install @redoykumardas/snaplink-sdk
```

For local development from this repository:

```bash
cd snaplink-sdk
npm ci
npm run test:ci
```

## Quick Start

```js
import { SnapchatClient } from "@redoykumardas/snaplink-sdk";

const snapchat = new SnapchatClient({
  browser: { headless: false },
  session: { key: process.env.SNAPCHAT_USERNAME },
});

try {
  await snapchat.init();

  if (!(await snapchat.isLoggedIn())) {
    await snapchat.login({
      username: process.env.SNAPCHAT_USERNAME,
      password: process.env.SNAPCHAT_PASSWORD,
    });
  }

  const friends = await snapchat.getFriends({ limit: 100 });
  await snapchat.sendMessage(friends[0].id, "Hello from SnapLink SDK");
} finally {
  await snapchat.close();
}
```

## Module Style API

Every public method is also available through grouped modules:

```js
await snapchat.api.auth.login({ username, password });
const friends = await snapchat.api.friends.getFriends({ limit: 100 });
await snapchat.api.messaging.sendMessage(friends[0].id, "Hello");
await snapchat.api.browser.close();
```

## Public API

Top-level methods:

- `init(config?)`
- `login(credentials)`
- `logout()`
- `isLoggedIn()`
- `getFriends(options?)`
- `getFriendStatus(options?)`
- `sendMessage(friendId, message, options?)`
- `getConversation(friendId)`
- `watchMessages(options)`
- `sendSnap(options)`
- `close()`

Grouped modules:

- `api.auth.login(credentials)`
- `api.auth.logout()`
- `api.auth.isLoggedIn()`
- `api.friends.getFriends(options?)`
- `api.friends.getFriendStatus(options?)`
- `api.messaging.sendMessage(friendId, message, options?)`
- `api.messaging.getConversation(friendId)`
- `api.messaging.watchMessages(options)`
- `api.snap.sendSnap(options)`
- `api.browser.close()`

Full method documentation is in [docs/api.md](docs/api.md).

## Configuration

```js
const snapchat = new SnapchatClient({
  browser: {
    headless: false,
    args: ["--start-maximized"],
  },
  session: {
    key: "account-name",
  },
  debug: {
    screenshots: true,
    directory: ".snapchat-debug",
  },
  logger: console,
});
```

`session.key` is the cookie storage key. `init()` attempts to restore cookies for this key, and `login()` saves cookies automatically after successful authentication. Applications do not call `saveCookies()` or `loadCookies()`.

## Sending Messages

```js
const friends = await snapchat.getFriends({ limit: 100 });

await snapchat.sendMessage(friends[0].id, "Hello");
await snapchat.sendMessage(friends[0].id, ["Line one", "Line two"]);
```

`sendMessage()` opens the chat internally and reuses the current chat when possible. Applications do not call `openChat()`.

## Reading Conversations

```js
const conversation = await snapchat.getConversation(friend.id);

console.log(conversation.id);
console.log(conversation.name);
console.log(conversation.chat);
```

## Watching New Messages

For auto-reply systems, use `watchMessages()` instead of constantly scanning every friend. By default there is no interval. The SDK installs a Snapchat sidebar `MutationObserver`, waits for notification/status changes such as `Received` or `New Chat`, confirms candidates by reading the chat, and deduplicates repeated events.

```js
const watcher = await snapchat.watchMessages({
  onMessage: async (event) => {
    const latest = event.latestMessage;
    if (!latest) return;

    await snapchat.sendMessage(event.friendId, "Auto reply here");
  },
  onError: (error) => {
    console.error("Watcher error:", error);
  },
});

// later
await watcher.stop();
```

To also react when someone opens your message, or when a new visible chat row appears, opt in with triggers:

```js
await snapchat.watchMessages({
  triggers: ["received", "new_chat", "opened", "new_friend"],
  onFriend: async (friend) => {
    await snapchat.sendMessage(friend.friendId, "Hi, nice to connect.");
  },
  onMessage: async (event) => {
    if (event.trigger === "opened") {
      await snapchat.sendMessage(event.friendId, "Saw you opened it. Want me to help?");
      return;
    }

    await snapchat.sendMessage(event.friendId, "Auto reply here");
  },
});
```

Optional backup polling can be enabled explicitly:

```js
await snapchat.watchMessages({
  fallbackPolling: true,
  fallbackIntervalMs: 60000,
  onMessage: async (event) => {
    await snapchat.sendMessage(event.friendId, "Auto reply here");
  },
});
```

Recommended auto-reply flow:

```txt
Snapchat notification/sidebar change
  -> SDK emits message candidate
  -> SDK queues event
  -> SDK opens only that chat
  -> SDK confirms latest incoming message
  -> your callback sends reply
  -> SDK deduplicates handled message
```

## Sending Snaps

Send a snap to specific friends from `getFriends()`:

```js
const friends = await snapchat.getFriends({ limit: 100 });

await snapchat.sendSnap({
  path: "./image.png",
  caption: "Hello",
  friendIds: friends.slice(0, 3).map(friend => friend.id),
});
```

Equivalent forms:

```js
await snapchat.sendSnap({
  path: "./image.png",
  friends: friends.slice(0, 3),
});

await snapchat.sendSnap({
  path: "./image.png",
  recipients: [friends[0].id, friends[1].id],
});
```

Shortcut and group-style sending are also supported:

```js
await snapchat.sendSnap({ path: "./image.png", target: "bestfriends" });
await snapchat.sendSnap({ path: "./image.png", target: "friends" });
await snapchat.sendSnap({ path: "./image.png", target: "groups" });
await snapchat.sendSnap({ path: "./image.png", shortcuts: ["close-friends"] });
```

## REST API Example

```js
import express from "express";
import { SnapchatClient } from "@redoykumardas/snaplink-sdk";

const app = express();
app.use(express.json());

const snapchat = new SnapchatClient({
  browser: { headless: true },
  session: { key: process.env.SNAPCHAT_USERNAME },
});

app.post("/init", async (_req, res) => {
  const state = await snapchat.init();
  res.json({ state });
});

app.get("/friends", async (req, res) => {
  const friends = await snapchat.getFriends({ limit: Number(req.query.limit) || 100 });
  res.json({ friends });
});

app.post("/messages", async (req, res) => {
  await snapchat.sendMessage(req.body.friendId, req.body.message);
  res.json({ ok: true });
});

app.listen(3000);
```

More examples are in [examples](examples).

## Live Smoke Test

The package includes a live smoke test for browser and Snapchat Web behavior:

```bash
npm run test:live
```

By default the live smoke test validates input handling, launches Snapchat, restores cookies or logs in, loads up to 100 friends, opens a chat through `getConversation()`, checks friend status, and exercises `sendSnap()` up to preview/caption. It does not submit a real message or snap unless explicitly enabled.

To submit a real snap to selected friend IDs:

```bash
SNAPCHAT_LIVE_SEND=1 \
SNAPCHAT_TEST_IMAGE=/home/redoy/Documents/Production-line/SnapBot/Redoy-removebg-preview.jpg \
SNAPCHAT_SNAP_FRIEND_IDS=friend_id_1,friend_id_2 \
npm run test:live
```

Other live-send options:

```bash
SNAPCHAT_LIVE_SEND=1 SNAPCHAT_SNAP_TARGET=bestfriends npm run test:live
SNAPCHAT_LIVE_SEND=1 SNAPCHAT_SNAP_TARGET=friends npm run test:live
SNAPCHAT_LIVE_SEND=1 SNAPCHAT_SNAP_TARGET=groups npm run test:live
SNAPCHAT_LIVE_SEND=1 SNAPCHAT_SNAP_SHORTCUTS=name1,name2 npm run test:live
```

## Environment Variables

See [.env.example](.env.example) for all live-test variables.

## Architecture

```txt
Application
  -> SnapchatClient public API
  -> Feature services
  -> AutomationEngine
  -> PrivateSnapchatEngine
  -> Puppeteer Extra + Stealth
  -> Snapchat Web
```

Architecture notes are in [docs/architecture/overview.md](docs/architecture/overview.md).

## Publishing

Before publishing locally:

```bash
npm run test:ci
npm run pack:dry
```

Manual npm release:

```bash
npm run version:patch
npm publish --access public
```

GitHub release flow:

```bash
git add .
git commit -m "Release v1.0.0"
git tag v1.0.0
git push origin main --tags
```

Then create a GitHub Release from tag `v1.0.0`. The `Publish` GitHub Action runs tests and publishes `@redoykumardas/snaplink-sdk` to npm using the repository secret `NPM_TOKEN`.

Use `version:minor` or `version:major` when the release requires it. See [docs/versioning.md](docs/versioning.md).

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md).

## Important Note

This SDK automates Snapchat Web through a browser. Snapchat UI changes can require selector updates. Use this package only with accounts and workflows you are authorized to operate, and keep usage compliant with the services involved.
