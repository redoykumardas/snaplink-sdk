export type Friend = {
  id: string;
  name: string;
};

export type FriendStatus = {
  type: "say_hi" | "new_chat" | "new_snap" | "opened" | "received" | "delivered" | null;
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
};

export type LimitOptions = number | {
  limit?: number;
};

export type SendMessageOptions = {
  exit?: boolean;
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
  source: "poll" | string;
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

export declare class SnapchatSDKError extends Error {
  code: string;
  details?: unknown;
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
  sendMessage(friendId: string, message: string | string[], options?: SendMessageOptions): Promise<void>;
  getConversation(friendId: string): Promise<Conversation>;
  watchMessages(options: WatchMessagesOptions): Promise<MessageWatcherHandle>;
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
  sendMessage(friendId: string, message: string | string[], options?: SendMessageOptions): Promise<void>;
  getConversation(friendId: string): Promise<Conversation>;
  watchMessages(options: WatchMessagesOptions): Promise<MessageWatcherHandle>;
  sendSnap(options: SendSnapOptions): Promise<void>;
  close(): Promise<void>;
}

export default SnapchatClient;
