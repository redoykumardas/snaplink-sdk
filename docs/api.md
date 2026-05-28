# API Reference

This reference covers the published SDK surface for `@redoykumardas/snaplink-sdk`.

## Import

```js
import SnapchatClient, {
  SnapchatClient as NamedClient,
  SnapchatSDKError,
  ErrorCodes,
} from "@redoykumardas/snaplink-sdk";
```

`SnapchatClient` and the default export reference the same class.

## Constructor

### `new SnapchatClient(config?)`

Creates a client instance. The browser is not launched until `init()` is called.

```js
const snapchat = new SnapchatClient({
  browser: { headless: false },
  session: { key: "my-account" },
  debug: { screenshots: true, directory: ".snapchat-debug" },
  logger: console,
});
```

Config fields:

| Field | Description |
| --- | --- |
| `browser` | Puppeteer launch options such as `headless`, `args`, `executablePath`, and `userDataDir`. |
| `session.key` | Cookie storage key. The SDK reads/writes `<key>-cookies.json`. |
| `debug.screenshots` | Enables screenshots for selected failure paths. |
| `debug.directory` | Directory for debug screenshots. |
| `logger` | Optional logger with `debug`, `info`, `warn`, and `error` methods. |

## Browser Lifecycle

### `init(config?)`

Launches Chromium, applies stealth setup, restores cookies when possible, opens Snapchat Web, and waits until the page is ready for login or app usage.

```js
const state = await snapchat.init();
```

Returns a state string such as `"login_ready"` or `"app_ready"`.

You can merge extra config at startup:

```js
await snapchat.init({
  browser: { headless: true },
});
```

### `close()`

Stops active watchers, closes the browser, and clears the internal session.

```js
try {
  await snapchat.init();
  // work
} finally {
  await snapchat.close();
}
```

Always call `close()` from `finally` blocks in jobs, test runners, and servers.

## Authentication

### `login(credentials)`

Logs in with username and password. If `session.key` is configured, cookies are saved automatically after a successful login.

```js
await snapchat.login({
  username: process.env.SNAPCHAT_USERNAME,
  password: process.env.SNAPCHAT_PASSWORD,
});
```

### `logout()`

Attempts to log out from the active Snapchat Web session.

```js
await snapchat.logout();
```

Use `logout()` only when you want to end the saved session. Use `close()` when you only want to stop the current browser run.

### `isLoggedIn()`

Returns `true` when the current browser session is authenticated.

```js
if (!(await snapchat.isLoggedIn())) {
  await snapchat.login({ username, password });
}
```

## Friends

### `getFriends(options?)`

Loads friends from Snapchat's virtualized recipient list.

```js
const friends = await snapchat.getFriends({ limit: 100 });
const filtered = await snapchat.getFriends({ search: "alex", limit: 20 });
```

Accepted options:

| Option | Description |
| --- | --- |
| `limit` | Maximum number of friends to return. |
| `search` | Case-insensitive filter applied to friend name or ID. |

Shortcut forms:

```js
await snapchat.getFriends(50);
await snapchat.getFriends("alex");
```

Return shape:

```ts
type Friend = {
  id: string;
  name: string;
};
```

### `getFriendStatus(options?)`

Returns friend rows with the latest visible status.

```js
const statuses = await snapchat.getFriendStatus({ limit: 100 });
```

Return shape:

```ts
type FriendStatusRecord = {
  id: string;
  name: string;
  status: {
    type: string | null;
    time: string | null;
    streak: string | null;
  };
};
```

## Messaging

### `sendMessage(friendId, message, options?)`

Opens the chat internally and sends one message or an array of messages.

```js
await snapchat.sendMessage(friend.id, "Hello");

await snapchat.sendMessage(friend.id, [
  "First message",
  "Second message",
]);
```

Options:

| Option | Description |
| --- | --- |
| `exit` | When `true`, attempts to leave the chat after sending. |

```js
await snapchat.sendMessage(friend.id, "Done", { exit: true });
```

Use friend IDs returned by `getFriends()`. The public SDK does not require `openChat()`.

### `getConversation(friendId, options?)`

Opens a chat and extracts visible conversation blocks.

```js
const conversation = await snapchat.getConversation(friend.id, {
  maxMessages: 25,
  timeout: 30000,
});
```

Options:

| Option | Description |
| --- | --- |
| `timeout` | Maximum extraction time in milliseconds. Default: `30000`. |
| `maxMessages` | Optional maximum number of messages to extract. |
| `signal` | Optional `AbortSignal` for cancellation. |

Return shape:

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

### `getConversations(friendIds, options?)`

Reads multiple conversations and returns a `Map` keyed by friend ID.

```js
const conversations = await snapchat.getConversations(
  friends.slice(0, 5).map(friend => friend.id),
  {
    timeout: 60000,
    maxMessages: 20,
    onProgress: ({ current, total, friendId }) => {
      console.log({ current, total, friendId });
    },
  }
);
```

Options:

| Option | Description |
| --- | --- |
| `timeout` | Total timeout budget in milliseconds. Default: `60000`. |
| `maxMessages` | Optional maximum messages per conversation. |
| `signal` | Optional `AbortSignal` for cancellation. |
| `onProgress` | Callback after each processed friend or batch. |
| `parallel` | `false` for serial reads, `true` for batches of 3, or a number for batch size. |

Values can include an `error` field when one friend's conversation cannot be read.

## Message Watching

### `watchMessages(options)`

Starts a sidebar watcher for auto-reply and event-driven workflows.

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

await watcher.stop();
```

Options:

| Option | Description |
| --- | --- |
| `onMessage(event)` | Required callback for message events. |
| `onFriend(event)` | Optional callback for `new_friend` events. |
| `onError(error)` | Optional watcher error callback. |
| `triggers` | Trigger list. Default: `["new_chat", "new_snap", "opened", "received", "delivered", "say_hi"]`. |
| `limit` | Friend/status rows used by fallback scans. Default: `100`. |
| `fallbackPolling` | Enables backup interval polling. Default: `false`. |
| `fallbackIntervalMs` | Backup polling interval. Default: `60000`. |
| `pollOnStart` | Runs fallback polling immediately on start. Default: `false`. |
| `includeExisting` | Emits already-visible rows on startup. Default: `false`. |
| `confirmConversation` | Opens the chat and reads the latest message before callback. Default: `true`. |
| `ignoreOwnMessages` | Skips own messages except `opened` events. Default: `true`. |
| `dedupe` | Suppresses repeated event/message keys. Default: `true`. |

Supported triggers:

- `received`
- `new_chat`
- `new_snap`
- `opened`
- `delivered`
- `say_hi`
- `unread`
- `new_friend`
- `all`

Event shape:

```ts
type MessageWatchEvent = {
  kind: "message";
  id: string;
  friendId: string;
  name: string;
  source: "dom" | "poll" | string;
  trigger: string;
  status: FriendStatus;
  statusText: string;
  previewText: string;
  detectedAt: number;
  conversation: Conversation | null;
  latestMessage: ConversationMessage | null;
  messageKey: string | null;
  raw?: unknown;
};
```

### `onEvent(callback)`

Shortcut for common sidebar events when you want the raw event flow without conversation confirmation.

```js
const watcher = await snapchat.onEvent(async (event) => {
  console.log(event.trigger, event.friendId, event.name);
});
```

Internally this watches `new_chat`, `new_snap`, `opened`, `received`, `delivered`, and `say_hi` with `confirmConversation: false`.

## Snaps

### `sendSnap(options)`

Creates a snap from a local image path, optionally adds a caption, and sends it when recipients are provided.

```js
await snapchat.sendSnap({
  path: "./image.png",
  caption: "Hello",
  friendIds: friends.slice(0, 3).map(friend => friend.id),
});
```

Options:

| Option | Description |
| --- | --- |
| `path` or `imagePath` | Required local image path. |
| `caption` | Optional caption text. |
| `friendIds` | Friend IDs returned by `getFriends()`. |
| `friends` | Friend objects or string IDs. |
| `recipients` | String target or array of friend objects/IDs. |
| `target` | Snapchat section such as `"bestfriends"`, `"friends"`, or `"groups"`. |
| `group` | Alias for `target`. |
| `shortcuts` | Snapchat shortcut names. |

Recipient examples:

```js
await snapchat.sendSnap({ path: "./image.png", friends: friends.slice(0, 3) });
await snapchat.sendSnap({ path: "./image.png", recipients: [friends[0].id] });
await snapchat.sendSnap({ path: "./image.png", target: "bestfriends" });
await snapchat.sendSnap({ path: "./image.png", shortcuts: ["close-friends"] });
```

If no recipients are provided, the SDK creates the snap preview but does not send it.

## Grouped API

Every major feature is also available through grouped modules:

```js
await snapchat.api.auth.login({ username, password });
await snapchat.api.friends.getFriends({ limit: 100 });
await snapchat.api.messaging.sendMessage(friendId, "Hello");
await snapchat.api.messaging.getConversation(friendId);
await snapchat.api.messaging.getConversations(friendIds);
await snapchat.api.messaging.watchMessages({ onMessage });
await snapchat.api.messaging.onEvent(callback);
await snapchat.api.snap.sendSnap({ path, friendIds });
await snapchat.api.browser.close();
```

Aliases:

- `snapchat.auth`
- `snapchat.authentication`
- `snapchat.friends`
- `snapchat.messaging`
- `snapchat.snap`
- `snapchat.browser`

## Errors

SDK failures use `SnapchatSDKError` where possible.

```js
try {
  await snapchat.sendMessage("", "Hello");
} catch (error) {
  if (error instanceof SnapchatSDKError) {
    console.error(error.code, error.message);
  }
}
```

Common error codes:

- `NOT_INITIALIZED`
- `AUTH_FAILED`
- `BROWSER_CLOSED`
- `CHAT_NOT_FOUND`
- `INVALID_INPUT`
- `OPERATION_FAILED`
- `FRIEND_LIST_TIMEOUT`
- `LOGIN_INPUT_NOT_FOUND`
- `SNAP_CAMERA_ERROR`
- `MESSAGE_SEND_FAILED`
- `CONVERSATION_TIMEOUT`
- `UPLOAD_FAILED`
- `CAPTCHA_DETECTED`
- `FRIEND_LIST_EMPTY`

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
