# Troubleshooting

## Browser Does Not Launch

Common causes:

- Chromium sandbox restrictions in containers.
- Missing Linux browser dependencies.
- Read-only cache paths.
- No display available while `headless: false`.

Useful launch options:

```js
const snapchat = new SnapchatClient({
  browser: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--disable-crashpad",
    ],
  },
});
```

## Login Shows CAPTCHA or Identity Verification

CAPTCHA and identity verification must be solved manually. After solving it once, run the SDK with a reusable session key or a persistent Chrome profile.

Recommended first option:

```js
const snapchat = new SnapchatClient({
  browser: { headless: false },
  session: { key: process.env.SNAPCHAT_USERNAME },
});
```

Flow:

1. Start with `headless: false`.
2. Call `init()`.
3. If Snapchat asks for verification, complete it manually in the opened browser.
4. Call `login()`.
5. The SDK saves cookies automatically using `session.key`.
6. Later runs can restore the session with `init()`.

If you need to use a local Chrome profile:

```js
const snapchat = new SnapchatClient({
  browser: {
    headless: false,
    userDataDir: "/path/to/chrome-user-data",
  },
});
```

Do not commit browser profiles or cookies.

## Friend List Returns Fewer Friends Than Expected

Snapchat uses a virtualized list, so only visible rows exist in the DOM at one time. The SDK scrolls and caches rows internally, but the visible list can still be affected by network speed, UI changes, or account state.

Try:

```js
const friends = await snapchat.getFriends({ limit: 100 });
```

If a limit cannot be reached, check the live smoke test output:

```bash
npm run test:live
```

## Chat Not Found

The SDK first tries visible rows, then cached friend-list positions. Call `getFriends()` before chat-heavy flows:

```js
const friends = await snapchat.getFriends({ limit: 100 });
await snapchat.sendMessage(friends[0].id, "Hello");
```

## Snap Preview Fails

`sendSnap()` tries image upload, fake camera capture, preview replacement, and caption entry. In browser-restricted environments, fake camera access can fail.

Try running with these browser args:

```js
browser: {
  headless: false,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--enable-media-stream",
  ],
}
```

## Debug Screenshots

Enable screenshots:

```js
const snapchat = new SnapchatClient({
  debug: {
    screenshots: true,
    directory: ".snapchat-debug",
  },
});
```

Generated screenshots are ignored by git.
