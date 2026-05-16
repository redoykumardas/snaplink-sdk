import { ErrorCodes, wrapError } from "../../shared/errors/SnapchatError.js";

function getLimit(input) {
  if (Number.isInteger(input)) return input;
  if (input && Number.isInteger(input.limit)) return input.limit;
  return null;
}

export class StatusService {
  constructor(engine) {
    this.engine = engine;
  }

  async getFriendStatus(options = {}) {
    try {
      return await (await this.engine.getReadyBot()).userStatus(getLimit(options));
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to retrieve Snapchat friend status", error);
    }
  }
}
