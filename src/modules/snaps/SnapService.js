import { ErrorCodes, SnapchatSDKError, wrapError } from "../../shared/errors/SnapchatError.js";

function getFriendRecipients(options) {
  const source = options.friendIds ?? options.friends ?? (
    Array.isArray(options.recipients) ? options.recipients : null
  );

  if (!Array.isArray(source)) return [];

  return source
    .map((friend) => {
      if (typeof friend === "string") return { id: friend, name: friend };
      if (!friend || typeof friend !== "object") return null;
      return {
        id: friend.id ?? friend.userId ?? friend.username ?? friend.name,
        name: friend.name ?? friend.displayName ?? friend.username ?? friend.id,
      };
    })
    .filter(friend => friend?.id || friend?.name);
}

export class SnapService {
  constructor(engine) {
    this.engine = engine;
  }

  async sendSnap(options = {}) {
    const imagePath = options.path ?? options.imagePath;
    const friendRecipients = getFriendRecipients(options);
    const target = options.target ?? options.group ?? (
      typeof options.recipients === "string" ? options.recipients : null
    );

    if (!imagePath) {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "sendSnap() requires path or imagePath.");
    }

    try {
      const bot = await this.engine.getReadyBot();
      await bot.captureSnap({ path: imagePath, caption: options.caption });

      if (friendRecipients.length) {
        return await bot.sendToFriends(friendRecipients);
      }

      if (Array.isArray(options.shortcuts)) {
        return await bot.useShortcut(options.shortcuts);
      }

      if (target) {
        return await bot.send(target);
      }

      return undefined;
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to send Snapchat snap", error);
    }
  }
}
