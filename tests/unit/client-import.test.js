import test from "node:test";
import assert from "node:assert/strict";
import { SnapchatClient, ErrorCodes, SnapchatSDKError } from "../../src/index.js";

test("exports the public SDK surface", () => {
  assert.equal(typeof SnapchatClient, "function");
  assert.equal(typeof SnapchatSDKError, "function");
  assert.equal(typeof ErrorCodes.NOT_INITIALIZED, "string");
});

test("client exposes high-level Snapchat methods", () => {
  const client = new SnapchatClient();

  for (const method of [
    "init",
    "login",
    "logout",
    "isLoggedIn",
    "getFriends",
    "getFriendStatus",
    "sendMessage",
    "getConversation",
    "watchMessages",
    "sendSnap",
    "close",
  ]) {
    assert.equal(typeof client[method], "function");
  }

  assert.equal(typeof client.api.auth.login, "function");
  assert.equal(typeof client.api.friends.getFriends, "function");
  assert.equal(typeof client.api.friends.getFriendStatus, "function");
  assert.equal(typeof client.api.messaging.sendMessage, "function");
  assert.equal(typeof client.api.messaging.getConversation, "function");
  assert.equal(typeof client.api.messaging.watchMessages, "function");
  assert.equal(typeof client.api.snap.sendSnap, "function");
  assert.equal(typeof client.api.browser.close, "function");
  assert.equal(typeof client.messaging.openChat, "undefined");
  assert.equal(typeof client.chat, "undefined");
  assert.equal(typeof client._chat, "undefined");
  assert.equal(typeof client.engine, "undefined");
  assert.equal(typeof client.openChat, "undefined");
  assert.equal(typeof client.saveCookies, "undefined");
  assert.equal(typeof client.loadCookies, "undefined");
  assert.equal(typeof client.handlePopups, "undefined");
});

test("watchMessages validates callback before starting browser work", async () => {
  const client = new SnapchatClient();

  await assert.rejects(
    () => client.watchMessages(),
    (error) => error instanceof SnapchatSDKError && error.code === ErrorCodes.INVALID_INPUT
  );
});
