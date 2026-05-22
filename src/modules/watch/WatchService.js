import { ErrorCodes, SnapchatSDKError, wrapError } from "../../shared/errors/SnapchatError.js";

const DEFAULT_TRIGGERS = Object.freeze(["received", "new_chat", "new_snap", "unread"]);
const ALL_TRIGGERS = Object.freeze([...DEFAULT_TRIGGERS, "opened", "new_friend"]);

const DEFAULT_WATCH_OPTIONS = Object.freeze({
  limit: 100,
  triggers: DEFAULT_TRIGGERS,
  fallbackPolling: false,
  fallbackIntervalMs: 60000,
  pollOnStart: false,
  includeExisting: false,
  confirmConversation: true,
  ignoreOwnMessages: true,
  dedupe: true,
});

function getLastMessage(conversation) {
  const lastBlock = conversation?.chat?.at(-1);
  const lastMessage = lastBlock?.conversation?.at(-1);

  return { lastBlock, lastMessage };
}

function messageKey(friendId, block, message) {
  return [
    friendId,
    block?.time ?? "unknown",
    message?.from ?? "unknown",
    message?.text ?? "",
  ].join(":");
}

function normalizeTrigger(value) {
  const trigger = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (trigger === "all") return "all";
  if (trigger === "message" || trigger === "messages") return "received";
  if (trigger === "new_user" || trigger === "new_chat_row" || trigger === "friend") return "new_friend";

  return trigger;
}

function normalizeTriggers(triggers) {
  const selected = Array.isArray(triggers) && triggers.length
    ? triggers
    : DEFAULT_TRIGGERS;

  const normalized = selected.map(normalizeTrigger);
  if (normalized.includes("all")) return [...ALL_TRIGGERS];

  const allowed = new Set(ALL_TRIGGERS);
  const unique = normalized.filter((trigger, index, list) => {
    return allowed.has(trigger) && list.indexOf(trigger) === index;
  });

  return unique.length ? unique : [...DEFAULT_TRIGGERS];
}

function statusTrigger(statusType) {
  if (statusType === "opened" || statusType === "Opened") return "opened";
  if (statusType === "received" || statusType === "Received") return "received";
  if (statusType === "delivered" || statusType === "Delivered") return "delivered";
  if (statusType === "say_hi" || statusType === "new_chat" || statusType === "new_snap") return "received";
  return null;
}

export class WatchService {
  constructor(engine) {
    this.engine = engine;
    this.options = null;
    this.queue = [];
    this.processing = false;
    this.running = false;
    this.pollTimer = null;
    this.eventSeen = new Set();
    this.messageSeen = new Set();
    this.knownFriends = new Map();
  }

  async watchMessages(options = {}) {
    if (typeof options.onMessage !== "function") {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "watchMessages() requires an onMessage callback.");
    }

    await this.stop();

    this.options = {
      ...DEFAULT_WATCH_OPTIONS,
      ...options,
    };
    this.options.triggers = normalizeTriggers(this.options.triggers);
    this.queue = [];
    this.processing = false;
    this.running = true;
    this.eventSeen.clear();
    this.messageSeen.clear();
    this.knownFriends.clear();

    const bot = await this.engine.getReadyBot();

    if (
      typeof this.options.onFriend === "function" &&
      this.options.fallbackPolling &&
      this.options.triggers.includes("new_friend")
    ) {
      await this.seedKnownFriends();
    }

    await bot.startMessageWatcher(
      {
        includeExisting: this.options.includeExisting,
        triggers: this.options.triggers,
      },
      (event) => this.enqueue(event)
    );

    if (this.options.fallbackPolling) {
      this.startFallbackPolling();
      if (this.options.pollOnStart) {
        this.runFallbackPoll().catch((error) => this.handleError(error));
      }
    }

    return {
      stop: () => this.stop(),
      isRunning: () => this.running,
    };
  }

  async seedKnownFriends() {
    try {
      const friends = await (await this.engine.getReadyBot()).listRecipients(this.options.limit);

      for (const friend of friends) {
        this.knownFriends.set(friend.id, friend);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  startFallbackPolling() {
    this.stopFallbackPolling();

    this.pollTimer = setInterval(() => {
      this.runFallbackPoll().catch((error) => this.handleError(error));
    }, this.options.fallbackIntervalMs);
  }

  stopFallbackPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async runFallbackPoll() {
    if (!this.running) return;

    const bot = await this.engine.getReadyBot();

    if (
      typeof this.options.onFriend === "function" &&
      this.options.triggers.includes("new_friend")
    ) {
      const friends = await bot.listRecipients(this.options.limit);

      for (const friend of friends) {
        if (this.knownFriends.has(friend.id)) continue;

        this.knownFriends.set(friend.id, friend);
        await this.options.onFriend({
          ...friend,
          source: "poll",
          detectedAt: Date.now(),
        });
      }
    }

    const statuses = await bot.userStatus(this.options.limit);

    for (const friend of statuses) {
      const trigger = statusTrigger(friend.status?.type);

      if (trigger && this.options.triggers.includes(trigger)) {
        this.enqueue({
          kind: "message_candidate",
          source: "poll",
          trigger,
          friendId: friend.id,
          name: friend.name,
          status: friend.status,
          statusText: friend.status.type,
          previewText: "",
          detectedAt: Date.now(),
        });
      }
    }
  }

  enqueue(rawEvent) {
    if (!this.running || !rawEvent?.friendId) return;

    const eventKey = [
      rawEvent.source ?? "unknown",
      rawEvent.trigger ?? "",
      rawEvent.friendId,
      rawEvent.status?.type ?? rawEvent.statusType ?? "",
      rawEvent.previewText ?? rawEvent.statusText ?? "",
    ].join(":");

    if (this.options?.dedupe && this.eventSeen.has(eventKey)) return;
    this.eventSeen.add(eventKey);

    this.queue.push(rawEvent);
    this.processQueue().catch((error) => this.handleError(error));
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.running && this.queue.length) {
        const rawEvent = this.queue.shift();
        try {
          await this.handleMessageCandidate(rawEvent);
        } catch (error) {
          this.handleError(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async handleMessageCandidate(rawEvent) {
    const trigger = normalizeTrigger(rawEvent.trigger) || statusTrigger(rawEvent.status?.type) || "received";
    const event = {
      kind: "message",
      source: rawEvent.source ?? "dom",
      trigger,
      friendId: rawEvent.friendId,
      id: rawEvent.friendId,
      name: rawEvent.name ?? "Unknown",
      status: rawEvent.status ?? {
        type: rawEvent.statusType ?? (trigger === "opened" ? "opened" : trigger === "new_friend" ? null : "received"),
        time: null,
        streak: null,
      },
      statusText: rawEvent.statusText ?? "",
      previewText: rawEvent.previewText ?? "",
      detectedAt: rawEvent.detectedAt ?? Date.now(),
      conversation: null,
      latestMessage: null,
      messageKey: null,
      raw: rawEvent,
    };

    if (event.trigger === "new_friend" && typeof this.options.onFriend === "function") {
      await this.options.onFriend({
        id: event.id,
        friendId: event.friendId,
        name: event.name,
        source: event.source,
        status: event.status,
        statusText: event.statusText,
        previewText: event.previewText,
        detectedAt: event.detectedAt,
        raw: rawEvent,
      });

      if (!event.status?.type) return;
    }

    if (this.options.confirmConversation) {
      const bot = await this.engine.getReadyBot();
      await bot.openChat(event.friendId);

      const conversation = await bot.extractChatData(event.friendId);
      const { lastBlock, lastMessage } = getLastMessage(conversation);

      event.conversation = conversation;
      event.latestMessage = lastMessage ?? null;
      event.messageKey = messageKey(event.friendId, lastBlock, lastMessage);

      if (!lastMessage) return;
      if (this.options.ignoreOwnMessages && event.trigger !== "opened" && lastMessage.from === "Me") return;

      if (this.options.dedupe && this.messageSeen.has(event.messageKey)) return;
      this.messageSeen.add(event.messageKey);
    }

    await this.options.onMessage(event);
  }

  handleError(error) {
    if (typeof this.options?.onError === "function") {
      this.options.onError(error);
      return;
    }

    this.engine.logger.warn("watchMessages error", error);
  }

  async stop() {
    this.running = false;
    this.queue = [];
    this.stopFallbackPolling();

    if (!this.engine.bot) return;

    try {
      await this.engine.bot.stopMessageWatcher();
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to stop Snapchat message watcher", error);
    }
  }
}
