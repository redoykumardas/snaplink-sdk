import { ErrorCodes, SnapchatSDKError, wrapError } from "../../shared/errors/SnapchatError.js";

const CACHE_TTL = 10000;

export class ChatService {
  #chatCache;
  #mutex;

  constructor(engine) {
    this.engine = engine;
    this.currentChatId = null;
    this.#chatCache = new Map();
    this.#mutex = Promise.resolve();
  }

  async #withLock(fn) {
    const prev = this.#mutex;
    let release;
    this.#mutex = new Promise(resolve => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
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

  async openChat(friendId) {
    if (!friendId) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "openChat() requires friendId.");

    try {
      const result = await (await this.engine.getReadyBot()).openChat(friendId);
      this.currentChatId = friendId;
      return result;
    } catch (error) {
      throw wrapError(ErrorCodes.CHAT_NOT_FOUND, `Failed to open chat: ${friendId}`, error, { friendId });
    }
  }

  async sendMessage(friendId, message, options = {}) {
    if (!friendId) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "sendMessage() requires friendId.");
    if (!message) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "sendMessage() requires message.");

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
        throw wrapError(ErrorCodes.OPERATION_FAILED, `Failed to send message to ${friendId}`, error, { friendId });
      }
    });
  }

  async getConversation(friendId, options = {}) {
    if (!friendId) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "getConversation() requires friendId.");

    const { timeout = 30000, signal } = options;

    return this.#withLock(async () => {
      const cached = this.#getCached(friendId);
      if (cached) return cached;

      try {
        if (signal?.aborted) throw new Error("Operation aborted");

        if (this.currentChatId !== friendId) {
          await this.openChat(friendId);
        }

        if (signal?.aborted) throw new Error("Operation aborted");

        const bot = await this.engine.getReadyBot();
        const result = await bot.extractChatData(friendId, { timeout, signal });
        this.currentChatId = friendId;

        this.#setCache(friendId, result);

        return result;
      } catch (error) {
        if (error.message?.includes("aborted")) throw error;
        throw wrapError(ErrorCodes.OPERATION_FAILED, `Failed to get conversation for ${friendId}`, error, { friendId });
      }
    });
  }

  async getConversations(friendIds, options = {}) {
    if (!Array.isArray(friendIds) || !friendIds.length) {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "getConversations() requires an array of friendIds.");
    }

    const { timeout = 60000, signal, onProgress } = options;
    const results = new Map();

    for (let i = 0; i < friendIds.length; i++) {
      if (signal?.aborted) break;

      const friendId = friendIds[i];
      try {
        const perTimeout = Math.min(timeout / friendIds.length + 5000, 60000);
        const result = await this.getConversation(friendId, { timeout: perTimeout, signal });
        results.set(friendId, result);
      } catch (error) {
        results.set(friendId, { id: friendId, name: "Unknown", chat: [], error: error.message });
      }

      if (typeof onProgress === "function") {
        onProgress({ current: i + 1, total: friendIds.length, friendId, result: results.get(friendId) });
      }
    }

    return results;
  }
}
