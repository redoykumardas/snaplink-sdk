# API Reference

This document describes the public SDK surface. Everything outside these methods is internal and may change without notice.

## Import

```js
import SnapchatClient, { SnapchatClient as NamedClient } from "@redoykumardas/snaplink-sdk";
```

Both exports reference the same class.

## Constructor

### `new SnapchatClient(config?)`

Creates a client instance. It does not launch a browser until `init()` is called.

```js
const snapchat = new SnapchatClient({
  browser: { headless: false },
  session: { key: "my-account" },
  debug: { screenshots: true, directory: ".snapchat-debug" },
  logger: console,
});
```

Config fields:

- `browser`: Puppeteer launch options such as `headless`, `args`, `executablePath`, and `userDataDir`.
- `session.key`: cookie/session key. The SDK reads and writes `<key>-cookies.json`.
- `debug.screenshots`: enables automatic screenshots for selected failure paths.
- `debug.directory`: screenshot output directory.
- `logger`: object with optional `debug`, `info`, `warn`, and `error` methods.

## Browser Lifecycle

### `init(config?)`

Launches the browser, applies stealth settings, restores cookies if `session.key` exists, opens Snapchat Web, starts state monitoring, and waits until Snapchat is ready for login or app usage.

Returns the ready state string, usually `"login_ready"` or `"app_ready"`.

```js
const state = await snapchat.init();

if (state === "login_ready") {
  await snapchat.login({ username, password });
}
```

You may pass extra config to merge into the constructor config:

```js
await snapchat.init({
  browser: { headless: true },
});
```

### `close()`

Closes the browser and clears the internal engine instance.

```js
try {
  await snapchat.init();
  // work
} finally {
  await snapchat.close();
}
```

Always call `close()` from `finally` blocks in servers, jobs, and test runners.

## Authentication

### `login(credentials)`

Logs in with username and password. If `session.key` is configured, cookies are saved automatically after successful login.

```js
await snapchat.login({
  username: process.env.SNAPCHAT_USERNAME,
  password: process.env.SNAPCHAT_PASSWORD,
});
```

Credentials:

- `username`: Snapchat username or login identifier.
- `password`: Snapchat password.

The application does not call `saveCookies()`. Cookie persistence is internal.

### `logout()`

Attempts to log out from the active Snapchat Web session.

```js
await snapchat.logout();
```

Use this only when you intentionally want to end the saved session. For long-running services, usually call `close()` instead so cookies remain reusable.

### `isLoggedIn()`

Checks the current Snapchat state.

```js
if (!(await snapchat.isLoggedIn())) {
  await snapchat.login({ username, password });
}
```

Returns `true` when the app is ready and authenticated, otherwise `false`.

## Friends

### `getFriends(options?)`

Loads friends from Snapchat's virtualized list.

```js
const friends = await snapchat.getFriends({ limit: 100 });
```

Options:

- `limit`: maximum number of friends to return.

You can also pass a number:

```js
const friends = await snapchat.getFriends(50);
```

Return value:

```ts
type Friend = {
  id: string;
  name: string;
};
```

The SDK keeps scroll-position cache internally so later chat/snap operations can jump to known friends faster.

### `getFriendStatus(options?)`

Returns friend rows with the latest visible message status.

```js
const statuses = await snapchat.getFriendStatus({ limit: 100 });
```

Return value:

```ts
type FriendStatusRecord = {
  id: string;
  name: string;
  status: {
    type: "Opened" | "Delivered" | "Received" | null;
    time: string | null;
    streak: string | null;
  };
};
```

## Messaging

### `sendMessage(friendId, message, options?)`

Opens the chat internally and sends one or more messages.

```js
await snapchat.sendMessage(friend.id, "Hello");
```

Send multiple messages:

```js
await snapchat.sendMessage(friend.id, [
  "First message",
  "Second message",
]);
```

Options:

- `exit`: when `true`, attempts to leave the chat after sending.

```js
await snapchat.sendMessage(friend.id, "Done", { exit: true });
```

The application does not call `openChat()`. The SDK opens and caches the chat internally.

### `getConversation(friendId)`

Opens the chat internally and extracts visible conversation blocks.

```js
const conversation = await snapchat.getConversation(friend.id);
```

Return value:

```ts
type Conversation = {
  id: string;
  name: string;
  chat: Array<{
    time: string;
    conversation: Array<{
      from: "Me" | string;
      text: string;
    }>;
  }>;
};
```

Example:

```js
const lastBlock = conversation.chat.at(-1);
const lastMessage = lastBlock?.conversation.at(-1);

if (lastMessage && lastMessage.from !== "Me") {
  await snapchat.sendMessage(conversation.id, "Thanks, I will reply soon.");
}
```

### `watchMessages(options)`

Starts a production-friendly watcher for auto-reply systems.

The watcher combines:

- DOM `MutationObserver` on Snapchat's sidebar for fast detection.
- Internal serial queue so only one browser action runs at a time.
- Deduplication to avoid repeated replies.
- Conversation confirmation so the callback receives the latest incoming message.
- Optional fallback polling only when you explicitly enable it.

```js
const watcher = await snapchat.watchMessages({
  onMessage: async (event) => {
    const latest = event.latestMessage;
    if (!latest) return;

    await snapchat.sendMessage(event.friendId, "Thanks for your message.");
  },
  onError: (error) => {
    console.error("Watcher error:", error);
  },
});
```

Stop watching:

```js
await watcher.stop();
```

Options:

- `onMessage(event)`: required callback for confirmed incoming message events.
- `onFriend(event)`: optional callback for `new_friend` trigger events.
- `onError(error)`: optional error callback.
- `triggers`: event types to watch. Default `["received", "new_chat", "new_snap", "unread"]`.
- `limit`: number of friend/status rows used by fallback scans. Default `100`.
- `fallbackPolling`: enable backup interval polling. Default `false`.
- `fallbackIntervalMs`: fallback polling interval. Default `60000`.
- `pollOnStart`: run fallback poll immediately. Default `false`.
- `includeExisting`: emit already-visible received rows during startup. Default `false`.
- `confirmConversation`: open the chat and confirm the latest message. Default `true`.
- `ignoreOwnMessages`: skip messages sent by `"Me"`. Default `true`.
- `dedupe`: suppress repeated row/message events. Default `true`.

Available triggers:

- `received`: sidebar status contains `Received`.
- `new_chat`: sidebar status contains `New Chat`.
- `new_snap`: sidebar status contains `New Snap`.
- `unread`: sidebar row appears unread.
- `opened`: sidebar status contains `Opened`. This can fire even when the latest confirmed message is from `"Me"`.
- `new_friend`: a new visible sidebar chat row appears after the watcher baseline scan.

Event-only auto-reply for received, opened, and new visible chat rows:

```js
await snapchat.watchMessages({
  triggers: ["received", "new_chat", "opened", "new_friend"],
  onFriend: async (friend) => {
    await snapchat.sendMessage(friend.friendId, "Hi, nice to connect.");
  },
  onMessage: async (event) => {
    if (event.trigger === "opened") {
      await snapchat.sendMessage(event.friendId, "Saw you opened it. Want a quick reply?");
      return;
    }

    await snapchat.sendMessage(event.friendId, "Auto reply here");
  },
});
```

Enable backup polling and new friend detection explicitly:

```js
await snapchat.watchMessages({
  fallbackPolling: true,
  fallbackIntervalMs: 60000,
  onFriend: async (friend) => {
    console.log("New friend/chat detected:", friend.name);
  },
  onMessage: async (event) => {
    await snapchat.sendMessage(event.friendId, "Auto reply here");
  },
});
```

Event shape:

```ts
type MessageWatchEvent = {
  id: string;
  friendId: string;
  name: string;
  source: "dom" | "poll" | string;
  trigger: "received" | "new_chat" | "new_snap" | "unread" | "opened" | "new_friend" | string;
  status: FriendStatus;
  statusText: string;
  previewText: string;
  detectedAt: number;
  conversation: Conversation | null;
  latestMessage: ConversationMessage | null;
  messageKey: string | null;
};
```

Auto-reply server pattern:

```js
await snapchat.watchMessages({
  onMessage: async (event) => {
    const latest = event.latestMessage;
    if (!latest?.text) return;

    const reply = await generateReply(latest.text, event.conversation);
    await snapchat.sendMessage(event.friendId, reply);
  },
});
```

## Snaps

### `sendSnap(options)`

Creates a snap from an image path, optionally adds a caption, then sends it to recipients if provided.

Basic image preview:

```js
await snapchat.sendSnap({
  path: "./image.png",
  caption: "Hello",
});
```

Send to multiple friend IDs from `getFriends()`:

```js
const friends = await snapchat.getFriends({ limit: 100 });

await snapchat.sendSnap({
  path: "./image.png",
  caption: "Hello",
  friendIds: friends.slice(0, 5).map(friend => friend.id),
});
```

Send using full friend objects:

```js
await snapchat.sendSnap({
  path: "./image.png",
  friends: friends.slice(0, 3),
});
```

Send using `recipients` array:

```js
await snapchat.sendSnap({
  path: "./image.png",
  recipients: [friends[0].id, friends[1].id],
});
```

Send to Snapchat sections:

```js
await snapchat.sendSnap({ path: "./image.png", target: "bestfriends" });
await snapchat.sendSnap({ path: "./image.png", target: "friends" });
await snapchat.sendSnap({ path: "./image.png", target: "groups" });
```

Send with shortcuts:

```js
await snapchat.sendSnap({
  path: "./image.png",
  shortcuts: ["close-friends", "customers"],
});
```

Options:

- `path` or `imagePath`: local image path.
- `caption`: optional caption text.
- `friendIds`: array of friend IDs returned by `getFriends()`.
- `friends`: array of friend objects or strings.
- `recipients`: string target or array of friend objects/IDs.
- `target`: `"bestfriends"`, `"friends"`, `"groups"`, or compatible Snapchat section name.
- `group`: alias for `target`.
- `shortcuts`: shortcut names.

## Grouped API

The grouped API is useful for REST services and workflow engines.

```js
await snapchat.api.auth.login({ username, password });
await snapchat.api.friends.getFriends({ limit: 100 });
await snapchat.api.messaging.sendMessage(friendId, "Hello");
await snapchat.api.messaging.watchMessages({ onMessage });
await snapchat.api.snap.sendSnap({ path, friendIds });
await snapchat.api.browser.close();
```

Aliases:

- `snapchat.auth` equals `snapchat.api.auth`.
- `snapchat.authentication` equals `snapchat.api.auth`.
- `snapchat.friends` equals `snapchat.api.friends`.
- `snapchat.messaging` equals `snapchat.api.messaging`.
- `snapchat.snap` equals `snapchat.api.snap`.
- `snapchat.browser` equals `snapchat.api.browser`.

## Errors

Errors are wrapped as `SnapchatSDKError` where possible.

```js
try {
  await snapchat.sendMessage("", "Hello");
} catch (error) {
  console.error(error.code);
  console.error(error.message);
}
```

Common codes:

- `NOT_INITIALIZED`: call `init()` first.
- `INVALID_INPUT`: required argument is missing.
- `AUTH_FAILED`: login failed.
- `CHAT_NOT_FOUND`: chat could not be opened.
- `OPERATION_FAILED`: browser or Snapchat operation failed.

## Recommended Server Pattern

```js
const snapchat = new SnapchatClient({
  browser: { headless: true },
  session: { key: process.env.SNAPCHAT_USERNAME },
});

let ready = false;

export async function ensureSnapchat() {
  if (ready) return snapchat;

  await snapchat.init();

  if (!(await snapchat.isLoggedIn())) {
    await snapchat.login({
      username: process.env.SNAPCHAT_USERNAME,
      password: process.env.SNAPCHAT_PASSWORD,
    });
  }

  ready = true;
  return snapchat;
}

process.on("SIGINT", async () => {
  await snapchat.close();
  process.exit(0);
});
```
