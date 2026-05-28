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

function formatRecipientsHint(options) {
  if (options.friendIds?.length) return `friendIds=[${options.friendIds.slice(0, 3).join(",")}${options.friendIds.length > 3 ? "..." : ""}]`;
  if (options.shortcuts?.length) return `shortcuts=${options.shortcuts.join(",")}`;
  if (options.target) return `target=${options.target}`;
  return "no recipients";
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

    if (typeof imagePath !== "string" || imagePath.trim().length === 0) {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "sendSnap() image path must be a non-empty string.");
    }

    const caption = typeof options.caption === "string" ? options.caption : "";

    try {
      const bot = await this.engine.getReadyBot();
      await bot.captureSnap({ path: imagePath, caption, position: options.position });

      if (friendRecipients.length) {
        return await bot.sendToFriends(friendRecipients);
      }

      if (Array.isArray(options.shortcuts)) {
        return await bot.useShortcut(options.shortcuts);
      }

      if (target) {
        return await bot.send(target);
      }

      console.warn("sendSnap: no recipients specified, snap captured but not sent");
      return;
    } catch (error) {
      const hint = formatRecipientsHint(options);
      if (error.message?.includes("camera") || error.message?.includes("upload")) {
        throw wrapError(ErrorCodes.SNAP_CAMERA_ERROR, `Failed to capture/send snap (${hint})`, error);
      }
      throw wrapError(ErrorCodes.OPERATION_FAILED, `Failed to send snap (${hint})`, error);
    }
  }
}
