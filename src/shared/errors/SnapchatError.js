export const ErrorCodes = Object.freeze({
  NOT_INITIALIZED: "NOT_INITIALIZED",
  AUTH_FAILED: "AUTH_FAILED",
  BROWSER_CLOSED: "BROWSER_CLOSED",
  CHAT_NOT_FOUND: "CHAT_NOT_FOUND",
  INVALID_INPUT: "INVALID_INPUT",
  OPERATION_FAILED: "OPERATION_FAILED",
  FRIEND_LIST_TIMEOUT: "FRIEND_LIST_TIMEOUT",
  LOGIN_INPUT_NOT_FOUND: "LOGIN_INPUT_NOT_FOUND",
  SNAP_CAMERA_ERROR: "SNAP_CAMERA_ERROR",
  MESSAGE_SEND_FAILED: "MESSAGE_SEND_FAILED",
  CONVERSATION_TIMEOUT: "CONVERSATION_TIMEOUT",
  UPLOAD_FAILED: "UPLOAD_FAILED",
  CAPTCHA_DETECTED: "CAPTCHA_DETECTED",
  FRIEND_LIST_EMPTY: "FRIEND_LIST_EMPTY",
});

export class SnapchatSDKError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "SnapchatSDKError";
    this.code = code;
    this.cause = options.cause;
    this.details = options.details;
  }
}

export function wrapError(code, message, error, details) {
  if (error instanceof SnapchatSDKError) return error;
  return new SnapchatSDKError(code, message, { cause: error, details });
}
