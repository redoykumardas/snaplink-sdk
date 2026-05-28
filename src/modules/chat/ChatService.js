import { ErrorCodes, SnapchatSDKError, wrapError } from "../../shared/errors/SnapchatError.js";

const CACHE_TTL = 10000;
const UUID_REGEX = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export class ChatService {
  #chatCache;
  #mutex;

  constructor(engine) {
    this.engine = engine;
    this.currentChatId = null;
    this.#chatCache = new Map();
    this.#mutex = Promise.resolve();
  }

  async #withLock(fn, timeoutMs = 0) {
    const prev = this.#mutex;
    let release;
    let timer;
    this.#mutex = new Promise(resolve => { release = resolve; });
    try {
      if (timeoutMs > 0) {
        await Promise.race([
          prev,
          new Promise((_, reject) =>
            timer = setTimeout(() => reject(new Error(`Mutex timeout after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);
        clearTimeout(timer);
      } else {
        await prev;
      }
      return await fn();
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  #getCached(friendId) {
    const entry = this.#chatCache.get(friendId);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
      return entry.data;
    }
    this.#chatCache.delete(friendId);
    return null;
  }

  #setCache(friendId, data) {
    this.#chatCache.set(friendId, { data, timestamp: Date.now() });
  }

  #invalidateCache(friendId) {
    this.#chatCache.delete(friendId);
  }

  #validateFriendId(friendId) {
    if (!friendId) return "sendMessage() requires friendId.";
    if (!UUID_REGEX.test(friendId)) {
      return `friendId must be a UUID (got "${String(friendId).slice(0, 20)}"). Use getFriends() to obtain friend IDs.`;
    }
    return null;
  }

  #validateMessage(message) {
    if (!message) return "message is required.";
    if (Array.isArray(message)) {
      if (message.length === 0) return "message array must not be empty.";
      const valid = message.every(m => typeof m === "string" || typeof m === "number");
      if (!valid) return "each message in the array must be a string or number.";
      return null;
    }
    if (typeof message !== "string" && typeof message !== "number") {
      return `message must be a string or string[], got ${typeof message}.`;
    }
    return null;
  }

  async openChat(friendId) {
    const err = this.#validateFriendId(friendId);
    if (err) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, err);

    try {
      const result = await (await this.engine.getReadyBot()).openChat(friendId);
      this.currentChatId = friendId;
      return result;
    } catch (error) {
      throw wrapError(ErrorCodes.CHAT_NOT_FOUND, `Failed to open chat: ${friendId}`, error, { friendId });
    }
  }

  async sendMessage(friendId, message, options = {}) {
    const friendErr = this.#validateFriendId(friendId);
    if (friendErr) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, friendErr);

    const msgErr = this.#validateMessage(message);
    if (msgErr) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, msgErr);

    return this.#withLock(async () => {
      try {
        if (this.currentChatId !== friendId) {
          await this.openChat(friendId);
        }

        const result = await (await this.engine.getReadyBot()).sendMessage({
          chat: friendId,
          message,
          exit: options.exit ?? false,
          alreadyOpen: true,
        });

        if (options.exit) {
          this.currentChatId = null;
        } else {
          this.currentChatId = friendId;
        }

        this.#invalidateCache(friendId);

        return result;
      } catch (error) {
        try {
          await this.engine.debug?.capture?.("sendMessage-error");
        } catch {}
        throw wrapError(ErrorCodes.OPERATION_FAILED, `Failed to send message to ${friendId}`, error, { friendId });
      }
    }, 60000);
  }

  async getConversation(friendId, options = {}) {
    const friendErr = this.#validateFriendId(friendId);
    if (friendErr) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, friendErr);

    const { timeout = 30000, signal, maxMessages } = options;

    return this.#withLock(async () => {
      if (signal?.aborted) throw new Error("Operation aborted");

      if (this.currentChatId !== friendId) {
        await this.openChat(friendId);
      }

      if (signal?.aborted) throw new Error("Operation aborted");

      try {
        const bot = await this.engine.getReadyBot();
        const result = await bot.extractChatData(friendId, { timeout, signal, maxMessages });
        this.currentChatId = friendId;

        this.#setCache(friendId, result);

        return result;
      } catch (error) {
        if (error.message?.includes("aborted")) throw error;
        throw wrapError(ErrorCodes.CONVERSATION_TIMEOUT, `Failed to get conversation for ${friendId}`, error, { friendId });
      }
    });
  }

  async getConversations(friendIds, options = {}) {
    if (!Array.isArray(friendIds) || !friendIds.length) {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "getConversations() requires an array of friendIds.");
    }

    const { timeout = 60000, signal, onProgress, maxMessages, parallel = false } = options;
    const results = new Map();

    if (parallel) {
      const concurrency = typeof parallel === "number" ? parallel : 3;
      const chunks = [];
      for (let i = 0; i < friendIds.length; i += concurrency) {
        chunks.push(friendIds.slice(i, i + concurrency));
      }

      for (const chunk of chunks) {
        if (signal?.aborted) break;

        const entries = await Promise.allSettled(
          chunk.map(async (friendId) => {
            const perTimeout = Math.min(timeout / friendIds.length + 5000, 60000);
            const result = await this.getConversation(friendId, { timeout: perTimeout, signal, maxMessages });
            return { friendId, result };
          })
        );

        for (const entry of entries) {
          if (entry.status === "fulfilled") {
            results.set(entry.value.friendId, entry.value.result);
          } else {
            const friendId = chunk[entries.indexOf(entry)];
            results.set(friendId, { id: friendId, name: "Unknown", chat: [], error: entry.reason?.message });
          }
        }

        if (typeof onProgress === "function") {
          onProgress({ current: results.size, total: friendIds.length });
        }
      }
    } else {
      for (let i = 0; i < friendIds.length; i++) {
        if (signal?.aborted) break;

        const friendId = friendIds[i];
        try {
          const perTimeout = Math.min(timeout / friendIds.length + 5000, 60000);
          const result = await this.getConversation(friendId, { timeout: perTimeout, signal, maxMessages });
          results.set(friendId, result);
        } catch (error) {
          results.set(friendId, { id: friendId, name: "Unknown", chat: [], error: error.message });
        }

        if (typeof onProgress === "function") {
          onProgress({ current: i + 1, total: friendIds.length, friendId, result: results.get(friendId) });
        }
      }
    }

    return results;
  }
}
