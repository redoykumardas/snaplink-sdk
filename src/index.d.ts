export type Friend = {
  id: string;
  name: string;
};

export type FriendStatusType =
  | "say_hi"
  | "new_chat"
  | "new_snap"
  | "opened"
  | "received"
  | "delivered"
  | "Opened"
  | "Received"
  | "Delivered"
  | string
  | null;

export type FriendStatus = {
  type: FriendStatusType;
  time: string | null;
  streak: string | null;
};

export type FriendStatusRecord = Friend & {
  status: FriendStatus;
};

export type MessageWatchTrigger =
  | "received"
  | "new_chat"
  | "new_snap"
  | "unread"
  | "opened"
  | "delivered"
  | "say_hi"
  | "new_friend";

export type ConversationMessage = {
  from: "Me" | string;
  text: string;
};

export type ConversationBlock = {
  time: string;
  conversation: ConversationMessage[];
};

export type Conversation = Friend & {
  chat: ConversationBlock[];
};

export type ConversationResult = Conversation & {
  error?: string;
};

export type Credentials = {
  username: string;
  password: string;
};

export type SnapchatClientConfig = {
  browser?: Record<string, unknown>;
  session?: {
    key?: string | null;
  };
  debug?: {
    screenshots?: boolean;
    directory?: string;
  };
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  engineOptions?: Record<string, unknown>;
  headless?: boolean | string;
  args?: string[];
  executablePath?: string;
  userDataDir?: string;
};

export type LimitOptions =
  | number
  | string
  | {
      limit?: number;
      search?: string;
    };

export type SendMessageValue = string | number | Array<string | number>;

export type SendMessageOptions = {
  exit?: boolean;
};

export type GetConversationOptions = {
  timeout?: number;
  signal?: AbortSignal;
  maxMessages?: number;
};

export type GetConversationsProgress = {
  current: number;
  total: number;
  friendId?: string;
  result?: ConversationResult;
};

export type GetConversationsOptions = {
  timeout?: number;
  signal?: AbortSignal;
  maxMessages?: number;
  parallel?: boolean | number;
  onProgress?: (progress: GetConversationsProgress) => void;
};

export type SendSnapOptions = {
  path?: string;
  imagePath?: string;
  caption?: string;
  friendIds?: string[];
  friends?: Array<string | Friend>;
  target?: "bestfriends" | "groups" | "friends" | string;
  group?: "bestfriends" | "groups" | "friends" | string;
  recipients?: "bestfriends" | "groups" | "friends" | string | Array<string | Friend>;
  shortcuts?: string[];
  position?: unknown;
};

export type MessageWatchEvent = Friend & {
  kind: "message";
  source: "dom" | "poll" | string;
  trigger: MessageWatchTrigger | string;
  friendId: string;
  status: FriendStatus;
  statusText: string;
  previewText: string;
  detectedAt: number;
  conversation: Conversation | null;
  latestMessage: ConversationMessage | null;
  messageKey: string | null;
  raw?: unknown;
};

export type NewFriendEvent = Friend & {
  source: "dom" | "poll" | string;
  friendId?: string;
  status?: FriendStatus;
  statusText?: string;
  previewText?: string;
  detectedAt: number;
  raw?: unknown;
};

export type MessageWatcherHandle = {
  stop(): Promise<void>;
  isRunning(): boolean;
};

export type WatchMessagesOptions = {
  onMessage(event: MessageWatchEvent): void | Promise<void>;
  onFriend?(event: NewFriendEvent): void | Promise<void>;
  onError?(error: unknown): void;
  triggers?: Array<MessageWatchTrigger | "all" | string>;
  limit?: number;
  fallbackPolling?: boolean;
  fallbackIntervalMs?: number;
  pollOnStart?: boolean;
  includeExisting?: boolean;
  confirmConversation?: boolean;
  ignoreOwnMessages?: boolean;
  dedupe?: boolean;
};

export type EventCallback = (event: MessageWatchEvent) => void | Promise<void>;

export declare const ErrorCodes: {
  readonly NOT_INITIALIZED: "NOT_INITIALIZED";
  readonly AUTH_FAILED: "AUTH_FAILED";
  readonly BROWSER_CLOSED: "BROWSER_CLOSED";
  readonly CHAT_NOT_FOUND: "CHAT_NOT_FOUND";
  readonly INVALID_INPUT: "INVALID_INPUT";
  readonly OPERATION_FAILED: "OPERATION_FAILED";
  readonly FRIEND_LIST_TIMEOUT: "FRIEND_LIST_TIMEOUT";
  readonly LOGIN_INPUT_NOT_FOUND: "LOGIN_INPUT_NOT_FOUND";
  readonly SNAP_CAMERA_ERROR: "SNAP_CAMERA_ERROR";
  readonly MESSAGE_SEND_FAILED: "MESSAGE_SEND_FAILED";
  readonly CONVERSATION_TIMEOUT: "CONVERSATION_TIMEOUT";
  readonly UPLOAD_FAILED: "UPLOAD_FAILED";
  readonly CAPTCHA_DETECTED: "CAPTCHA_DETECTED";
  readonly FRIEND_LIST_EMPTY: "FRIEND_LIST_EMPTY";
};

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export declare class SnapchatSDKError extends Error {
  name: "SnapchatSDKError";
  code: ErrorCode | string;
  details?: unknown;
  cause?: unknown;
}

export type SnapchatAuthApi = {
  login(credentials: Credentials): Promise<void>;
  logout(): Promise<void>;
  isLoggedIn(): Promise<boolean>;
};

export type SnapchatFriendsApi = {
  getFriends(options?: LimitOptions): Promise<Friend[]>;
  getFriendStatus(options?: LimitOptions): Promise<FriendStatusRecord[]>;
};

export type SnapchatMessagingApi = {
  sendMessage(friendId: string, message: SendMessageValue, options?: SendMessageOptions): Promise<void>;
  getConversation(friendId: string, options?: GetConversationOptions): Promise<Conversation>;
  getConversations(friendIds: string[], options?: GetConversationsOptions): Promise<Map<string, ConversationResult>>;
  watchMessages(options: WatchMessagesOptions): Promise<MessageWatcherHandle>;
  onEvent(callback: EventCallback): Promise<MessageWatcherHandle>;
};

export type SnapchatSnapApi = {
  sendSnap(options: SendSnapOptions): Promise<void>;
};

export type SnapchatBrowserApi = {
  close(): Promise<void>;
};

export type SnapchatApi = {
  auth: SnapchatAuthApi;
  friends: SnapchatFriendsApi;
  messaging: SnapchatMessagingApi;
  snap: SnapchatSnapApi;
  browser: SnapchatBrowserApi;
};

export declare class SnapchatClient {
  api: SnapchatApi;
  auth: SnapchatAuthApi;
  authentication: SnapchatAuthApi;
  friends: SnapchatFriendsApi;
  messaging: SnapchatMessagingApi;
  snap: SnapchatSnapApi;
  browser: SnapchatBrowserApi;

  constructor(config?: SnapchatClientConfig);
  init(config?: SnapchatClientConfig): Promise<string>;
  login(credentials: Credentials): Promise<void>;
  logout(): Promise<void>;
  isLoggedIn(): Promise<boolean>;
  getFriends(options?: LimitOptions): Promise<Friend[]>;
  getFriendStatus(options?: LimitOptions): Promise<FriendStatusRecord[]>;
  sendMessage(friendId: string, message: SendMessageValue, options?: SendMessageOptions): Promise<void>;
  getConversation(friendId: string, options?: GetConversationOptions): Promise<Conversation>;
  getConversations(friendIds: string[], options?: GetConversationsOptions): Promise<Map<string, ConversationResult>>;
  watchMessages(options: WatchMessagesOptions): Promise<MessageWatcherHandle>;
  onEvent(callback: EventCallback): Promise<MessageWatcherHandle>;
  sendSnap(options: SendSnapOptions): Promise<void>;
  close(): Promise<void>;
}

export default SnapchatClient;
