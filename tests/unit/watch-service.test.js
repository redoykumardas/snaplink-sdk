import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { WatchService } from "../../src/modules/watch/WatchService.js";

function createHarness({ conversation, statuses = [], friends = [] } = {}) {
  const calls = {
    startOptions: null,
    openChat: [],
    stopped: 0,
  };

  let watcherCallback = null;

  const bot = {
    startMessageWatcher: async (options, callback) => {
      calls.startOptions = options;
      watcherCallback = callback;
    },
    stopMessageWatcher: async () => {
      calls.stopped += 1;
    },
    openChat: async (friendId) => {
      calls.openChat.push(friendId);
    },
    extractChatData: async (friendId) => conversation ?? ({
      id: friendId,
      name: "Test Friend",
      chat: [
        {
          time: "Now",
          conversation: [
            {
              from: "Test Friend",
              text: "hello",
            },
          ],
        },
      ],
    }),
    userStatus: async () => statuses,
    listRecipients: async () => friends,
  };

  const engine = {
    bot,
    logger: {
      warn: () => {},
    },
    getReadyBot: async () => bot,
  };

  const service = new WatchService(engine);

  return {
    calls,
    service,
    emit: (event) => watcherCallback?.(event),
  };
}

async function waitForQueue(service) {
  for (let index = 0; index < 20; index += 1) {
    await flush();
    if (!service.processing && service.queue.length === 0) return;
  }
}

test("watchMessages passes normalized event triggers to the DOM watcher", async () => {
  const { service, calls } = createHarness();

  await service.watchMessages({
    triggers: ["Opened", "new user"],
    confirmConversation: false,
    onMessage: () => {},
  });

  assert.deepEqual(calls.startOptions.triggers, ["opened", "new_friend"]);

  await service.stop();
});

test("watchMessages can emit Opened events even when the latest chat item is from Me", async () => {
  const events = [];
  const { service, emit } = createHarness({
    conversation: {
      id: "friend-1",
      name: "Test Friend",
      chat: [
        {
          time: "Now",
          conversation: [
            {
              from: "Me",
              text: "last sent message",
            },
          ],
        },
      ],
    },
  });

  await service.watchMessages({
    triggers: ["opened"],
    onMessage: (event) => {
      events.push(event);
    },
  });

  emit({
    source: "dom",
    trigger: "opened",
    friendId: "friend-1",
    name: "Test Friend",
    status: {
      type: "Opened",
      time: "1m",
      streak: null,
    },
    statusText: "Opened 1m",
    previewText: "Opened 1m",
    detectedAt: 123,
  });

  await waitForQueue(service);

  assert.equal(events.length, 1);
  assert.equal(events[0].trigger, "opened");
  assert.equal(events[0].latestMessage.from, "Me");
});

test("watchMessages can emit new friend/chat row events without opening a chat", async () => {
  const friends = [];
  const { service, calls, emit } = createHarness();

  await service.watchMessages({
    triggers: ["new_friend"],
    onFriend: (friend) => {
      friends.push(friend);
    },
    onMessage: () => {
      throw new Error("new_friend without status should not call onMessage");
    },
  });

  emit({
    source: "dom",
    trigger: "new_friend",
    friendId: "friend-2",
    name: "New Friend",
    status: {
      type: null,
      time: null,
      streak: null,
    },
    statusText: "",
    previewText: "New Friend",
    detectedAt: 456,
  });

  await waitForQueue(service);

  assert.equal(friends.length, 1);
  assert.equal(friends[0].friendId, "friend-2");
  assert.equal(friends[0].name, "New Friend");
  assert.deepEqual(calls.openChat, []);
});

test("fallback polling respects the opened trigger when it is explicitly enabled", async () => {
  const events = [];
  const { service } = createHarness({
    statuses: [
      {
        id: "friend-3",
        name: "Opened Friend",
        status: {
          type: "Opened",
          time: "2m",
          streak: null,
        },
      },
    ],
  });

  await service.watchMessages({
    triggers: ["opened"],
    fallbackPolling: true,
    confirmConversation: false,
    onMessage: (event) => {
      events.push(event);
    },
  });

  await service.runFallbackPoll();
  await waitForQueue(service);

  assert.equal(events.length, 1);
  assert.equal(events[0].trigger, "opened");
  assert.equal(events[0].friendId, "friend-3");

  await service.stop();
});
