import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { SnapchatClient } from "../../src/index.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const imagePath = process.env.SNAPCHAT_TEST_IMAGE
  || fileURLToPath(new URL("../../../Redoy-removebg-preview.jpg", import.meta.url));

const credentials = {
  username: process.env.USER_NAME || process.env.SNAPCHAT_USERNAME,
  password: process.env.USER_PASSWORD || process.env.SNAPCHAT_PASSWORD,
};

const sessionKey = process.env.SNAPCHAT_SESSION_KEY || process.env.SNAPCHAT_USERNAME || credentials.username;
const friendLimit = toPositiveInteger(process.env.SNAPCHAT_TEST_LIMIT, 100);
const expectedFriendMinimum = toPositiveInteger(process.env.SNAPCHAT_EXPECT_MIN_FRIENDS, friendLimit);
const liveSend = process.env.SNAPCHAT_LIVE_SEND === "1";
const liveLogout = process.env.SNAPCHAT_LIVE_LOGOUT === "1";
const snapTarget = process.env.SNAPCHAT_SNAP_TARGET;
const snapShortcuts = parseCsv(process.env.SNAPCHAT_SNAP_SHORTCUTS);
const snapFriendIds = parseCsv(process.env.SNAPCHAT_SNAP_FRIEND_IDS);
const targetFriendId = process.env.SNAPCHAT_TEST_FRIEND_ID;
const testMessage = process.env.SNAPCHAT_TEST_MESSAGE || `snaplink-sdk live smoke ${new Date().toISOString()}`;
const snapCaption = process.env.SNAPCHAT_TEST_CAPTION || "snaplink-sdk live smoke";

const results = [];

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function record(name, status, details = "") {
  results.push({ name, status, details });
  const suffix = details ? ` - ${details}` : "";
  console.log(`[${status}] ${name}${suffix}`);
}

async function step(name, fn, { fatal = true } = {}) {
  try {
    const value = await fn();
    record(name, "pass");
    return value;
  } catch (error) {
    record(name, "fail", error.message);
    if (fatal) throw error;
    return undefined;
  }
}

async function rejects(name, fn) {
  try {
    await fn();
    throw new Error("Expected function to reject.");
  } catch (error) {
    if (error.message === "Expected function to reject.") throw error;
    record(name, "pass", error.code || error.message);
  }
}

async function runValidationChecks() {
  const client = new SnapchatClient();

  assert.equal(typeof client.openChat, "undefined");
  assert.equal(typeof client.saveCookies, "undefined");
  assert.equal(typeof client.loadCookies, "undefined");
  assert.equal(typeof client.handlePopups, "undefined");
  assert.equal(typeof client.messaging.openChat, "undefined");

  record("public API hides internal openChat/session/popup methods", "pass");

  await rejects("isLoggedIn before init rejects", () => client.isLoggedIn());
  await rejects("sendMessage without friendId rejects", () => client.sendMessage("", "hello"));
  await rejects("getConversation without friendId rejects", () => client.getConversation(""));
  await rejects("sendSnap without image path rejects", () => client.sendSnap({}));
}

async function runLiveChecks() {
  await access(imagePath);

  const snapchat = new SnapchatClient({
    browser: {
      headless: process.env.SNAPCHAT_HEADLESS === "true",
      args: [
        "--start-maximized",
        "--use-fake-ui-for-media-stream",
        "--enable-media-stream",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-crash-reporter",
        "--disable-crashpad",
        "--disable-dev-shm-usage",
      ],
    },
    session: { key: sessionKey },
    debug: {
      screenshots: true,
      directory: ".snapchat-debug",
    },
  });

  try {
    await step("init", () => snapchat.init());

    const wasLoggedIn = await step("isLoggedIn", () => snapchat.isLoggedIn());
    if (!wasLoggedIn) {
      if (!credentials.username || !credentials.password) {
        throw new Error("Missing USER_NAME/USER_PASSWORD or SNAPCHAT_USERNAME/SNAPCHAT_PASSWORD for live login.");
      }
      await step("login", () => snapchat.login(credentials));
    } else {
      record("login", "skip", "restored existing session");
    }

    await step("isLoggedIn after auth", async () => {
      assert.equal(await snapchat.isLoggedIn(), true);
    });

    const friends = await step(`getFriends limit ${friendLimit}`, () => snapchat.getFriends({ limit: friendLimit }));
    assert.ok(Array.isArray(friends), "getFriends must return an array");
    assert.ok(friends.length > 0, "getFriends returned no friends");
    assert.ok(
      friends.length >= Math.min(expectedFriendMinimum, friendLimit),
      `getFriends returned ${friends.length}, expected at least ${Math.min(expectedFriendMinimum, friendLimit)}`
    );

    const targetFriend = targetFriendId
      ? friends.find((friend) => friend.id === targetFriendId) || { id: targetFriendId, name: "env target" }
      : friends[0];

    await step("getConversation opens chat internally", () => snapchat.getConversation(targetFriend.id));
    await step("getFriendStatus", () => snapchat.getFriendStatus({ limit: Math.min(friendLimit, friends.length) }));

    const watcher = await step("watchMessages starts sidebar observer", () => snapchat.watchMessages({
      triggers: ["received", "new_chat", "opened", "new_friend"],
      fallbackPolling: false,
      confirmConversation: false,
      onFriend: async (event) => {
        console.log("Watcher new visible chat row:", event.name);
      },
      onMessage: async (event) => {
        console.log("Watcher candidate:", event.trigger, event.name);
      },
      onError: (error) => {
        console.error("Watcher error:", error);
      },
    }));
    await step("watchMessages stops sidebar observer", () => watcher.stop());

    if (liveSend) {
      await step("sendMessage opens chat internally", () => snapchat.sendMessage(targetFriend.id, testMessage));
    } else {
      record("sendMessage", "skip", "set SNAPCHAT_LIVE_SEND=1 to send a real message");
    }

    const snapOptions = {
      path: imagePath,
      caption: snapCaption,
    };

    if (snapShortcuts.length) {
      snapOptions.shortcuts = snapShortcuts;
    } else if (snapFriendIds.length) {
      snapOptions.friendIds = snapFriendIds;
    } else if (snapTarget) {
      snapOptions.target = snapTarget;
    }

    if (liveSend && (snapOptions.target || snapOptions.shortcuts || snapOptions.friendIds)) {
      await step("sendSnap with provided image", () => snapchat.sendSnap(snapOptions));
    } else {
      await step("sendSnap capture with provided image", () => snapchat.sendSnap({
        path: imagePath,
        caption: snapCaption,
      }));
      record("sendSnap submit", "skip", "set SNAPCHAT_LIVE_SEND=1 with SNAPCHAT_SNAP_FRIEND_IDS, SNAPCHAT_SNAP_TARGET, or SNAPCHAT_SNAP_SHORTCUTS");
    }

    if (liveLogout) {
      await step("logout", () => snapchat.logout(), { fatal: false });
    } else {
      record("logout", "skip", "set SNAPCHAT_LIVE_LOGOUT=1 to end the session");
    }
  } finally {
    await step("close", () => snapchat.close(), { fatal: false });
  }
}

await step("validation checks", runValidationChecks, { fatal: false });
await step("live checks", runLiveChecks, { fatal: false });

const failed = results.filter((item) => item.status === "fail");
const skipped = results.filter((item) => item.status === "skip");

console.log("\nSummary:");
console.log(JSON.stringify({
  passed: results.filter((item) => item.status === "pass").length,
  skipped: skipped.length,
  failed: failed.length,
}, null, 2));

if (failed.length) {
  process.exitCode = 1;
}
