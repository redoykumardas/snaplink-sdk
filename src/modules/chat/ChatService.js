import { ErrorCodes, SnapchatSDKError, wrapError } from "../../shared/errors/SnapchatError.js";

export class ChatService {
  constructor(engine) {
    this.engine = engine;
    this.currentChatId = null;
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

      return result;
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, `Failed to send message to ${friendId}`, error, { friendId });
    }
  }

  async getConversation(friendId) {
    if (!friendId) throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "getConversation() requires friendId.");

    try {
      if (this.currentChatId !== friendId) {
        await this.openChat(friendId);
      }

      const result = await (await this.engine.getReadyBot()).extractChatData(friendId);
      this.currentChatId = friendId;
      return result;
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, `Failed to get conversation for ${friendId}`, error, { friendId });
    }
  }
}
