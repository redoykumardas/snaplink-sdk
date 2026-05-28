import { ErrorCodes, wrapError } from "../../shared/errors/SnapchatError.js";

function getLimit(input) {
  if (Number.isInteger(input)) return input;
  if (input && Number.isInteger(input.limit)) return input.limit;
  return null;
}

function getSearch(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.search === "string") return input.search;
  return null;
}

export class FriendsService {
  constructor(engine) {
    this.engine = engine;
  }

  async getFriends(options = {}) {
    try {
      const limit = getLimit(options);
      const search = getSearch(options);
      const friends = await (await this.engine.getReadyBot()).listRecipients(limit);

      if (search) {
        const q = search.toLowerCase();
        const filtered = friends.filter(f =>
          f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
        );
        return limit ? filtered.slice(0, limit) : filtered;
      }

      return friends;
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to retrieve Snapchat friends", error);
    }
  }
}
