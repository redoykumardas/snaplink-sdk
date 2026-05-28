# SnapLink SDK

Unofficial Node.js SDK for automating Snapchat Web workflows with a clean, high-level API.

`@redoykumardas/snaplink-sdk` hides Puppeteer setup, browser lifecycle, login sessions, Snapchat selectors, scrolling, chat navigation, retries, message watching, and snap sending behind one client.

## Highlights

- Simple `SnapchatClient` API for auth, friends, messaging, snaps, and browser cleanup.
- Automatic cookie restore/save with `session.key`.
- Friend list and friend status extraction from Snapchat Web.
- Message sending, conversation reading, bulk conversation reads, and event-based watchers.
- Image snap creation with captions, friend IDs, groups, targets, and shortcuts.
- ESM package with bundled TypeScript declarations.

## Requirements

- Node.js 20 or newer.
- A Snapchat account you are authorized to operate.
- A runtime that can launch Chromium through Puppeteer.

This SDK automates Snapchat Web through a browser. Snapchat UI changes can require SDK updates. Use it responsibly and keep your usage compliant with the services involved.

## Installation

```bash
npm install @redoykumardas/snaplink-sdk
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

  const friends = await snapchat.getFriends({ limit: 50 });

  await snapchat.sendMessage(friends[0].id, "Hello from SnapLink SDK");
} finally {
  await snapchat.close();
}
```

## Client Setup

```js
const snapchat = new SnapchatClient({
  browser: {
    headless: false,
    args: ["--start-maximized"],
  },
  session: {
    key: "my-snapchat-account",
  },
  debug: {
    screenshots: true,
    directory: ".snapchat-debug",
  },
  logger: console,
});
```

`session.key` controls cookie storage. When it is set, `init()` attempts to restore the saved session and `login()` saves cookies after a successful login.

## API Overview

Top-level methods:

| Method | Purpose |
| --- | --- |
| `init(config?)` | Launch Snapchat Web and prepare the browser session. |
| `login(credentials)` | Log in with username and password. |
| `logout()` | Log out from the active Snapchat Web session. |
| `isLoggedIn()` | Check whether the current browser session is authenticated. |
| `getFriends(options?)` | Load friends from Snapchat's virtualized list. |
| `getFriendStatus(options?)` | Read visible friend status rows. |
| `sendMessage(friendId, message, options?)` | Send one or more chat messages. |
| `getConversation(friendId, options?)` | Read the visible conversation for one friend. |
| `getConversations(friendIds, options?)` | Read multiple conversations and return a `Map`. |
| `watchMessages(options)` | Watch sidebar changes and emit message events. |
| `onEvent(callback)` | Shortcut watcher for common sidebar events. |
| `sendSnap(options)` | Create and optionally send an image snap. |
| `close()` | Stop watchers and close the browser. |

Grouped modules are also available:

```js
await snapchat.api.auth.login({ username, password });
const friends = await snapchat.api.friends.getFriends({ limit: 100 });
await snapchat.api.messaging.sendMessage(friends[0].id, "Hello");
await snapchat.api.snap.sendSnap({ path: "./image.png", friendIds: [friends[0].id] });
await snapchat.api.browser.close();
```

See [docs/api.md](docs/api.md) for the full API reference.

## Friends

```js
const friends = await snapchat.getFriends({ limit: 100 });
const filtered = await snapchat.getFriends({ search: "alex", limit: 20 });
const statuses = await snapchat.getFriendStatus({ limit: 100 });
```

Friend IDs returned by `getFriends()` should be used for chat and snap operations.

## Messaging

```js
await snapchat.sendMessage(friend.id, "Hello");

await snapchat.sendMessage(friend.id, [
  "First message",
  "Second message",
]);

const conversation = await snapchat.getConversation(friend.id, {
  maxMessages: 25,
});
```

Bulk conversation reads return a `Map` keyed by friend ID:

```js
const conversations = await snapchat.getConversations(
  friends.slice(0, 5).map(friend => friend.id),
  {
    maxMessages: 20,
    onProgress: ({ current, total }) => {
      console.log(`${current}/${total}`);
    },
  }
);
```

## Watch Messages

Use `watchMessages()` for auto-reply systems instead of polling every friend manually.

```js
const watcher = await snapchat.watchMessages({
  triggers: ["received", "new_chat", "new_snap"],
  onMessage: async (event) => {
    const latest = event.latestMessage;
    if (!latest?.text) return;

    await snapchat.sendMessage(event.friendId, "Thanks for your message.");
  },
  onError: console.error,
});

// later
await watcher.stop();
```

Useful triggers include `received`, `new_chat`, `new_snap`, `opened`, `delivered`, `say_hi`, `unread`, and `new_friend`.

## Send Snaps

```js
await snapchat.sendSnap({
  path: "./image.png",
  caption: "Hello",
  friendIds: friends.slice(0, 3).map(friend => friend.id),
});
```

Other recipient styles:

```js
await snapchat.sendSnap({ path: "./image.png", friends: friends.slice(0, 3) });
await snapchat.sendSnap({ path: "./image.png", recipients: [friends[0].id] });
await snapchat.sendSnap({ path: "./image.png", target: "bestfriends" });
await snapchat.sendSnap({ path: "./image.png", shortcuts: ["close-friends"] });
```

## Examples

- [Basic client](examples/basic/index.js)
- [REST API server](examples/rest-api-server/index.js)
- [AI auto-reply starter](examples/ai-auto-reply/index.js)

## Local Development

```bash
cd snaplink-sdk
npm ci
npm run test:ci
```

Live browser verification is available when you provide credentials in `.env` or your shell:

```bash
npm run test:live
```

Real message or snap sending is disabled unless live-send environment variables are explicitly enabled. See [.env.example](.env.example).

## Publishing

Before publishing:

```bash
npm run test:ci
npm run pack:dry
```

Publish manually:

```bash
npm run version:patch
npm publish --access public
```

Use `version:minor` for backward-compatible features and `version:major` for breaking API changes.

## Documentation

- [API Reference](docs/api.md)

## License

ISC
