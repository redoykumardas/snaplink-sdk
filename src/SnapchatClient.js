import { AutomationEngine } from "./core/AutomationEngine.js";
import { AuthService } from "./modules/auth/AuthService.js";
import { FriendsService } from "./modules/friends/FriendsService.js";
import { ChatService } from "./modules/chat/ChatService.js";
import { SnapService } from "./modules/snaps/SnapService.js";
import { StatusService } from "./modules/status/StatusService.js";
import { WatchService } from "./modules/watch/WatchService.js";
import { ErrorCodes, SnapchatSDKError } from "./shared/errors/SnapchatError.js";

export class SnapchatClient {
  #engine;
  #auth;
  #friends;
  #chat;
  #snaps;
  #status;
  #watcher;

  constructor(config = {}) {
    this.#engine = new AutomationEngine(config);

    this.#auth = new AuthService(this.#engine);
    this.#friends = new FriendsService(this.#engine);
    this.#chat = new ChatService(this.#engine);
    this.#snaps = new SnapService(this.#engine);
    this.#status = new StatusService(this.#engine);
    this.#watcher = new WatchService(this.#engine);

    this.api = {
      auth: {
        login: (credentials) => this.login(credentials),
        logout: () => this.logout(),
        isLoggedIn: () => this.isLoggedIn(),
      },
      friends: {
        getFriends: (options = {}) => this.getFriends(options),
        getFriendStatus: (options = {}) => this.getFriendStatus(options),
      },
      messaging: {
        sendMessage: (friendId, message, options = {}) => this.sendMessage(friendId, message, options),
        getConversation: (friendId) => this.getConversation(friendId),
        watchMessages: (options = {}) => this.watchMessages(options),
        onEvent: (callback) => this.onEvent(callback),
      },
      snap: {
        sendSnap: (options = {}) => this.sendSnap(options),
      },
      browser: {
        close: () => this.close(),
      },
    };

    this.auth = this.api.auth;
    this.authentication = this.api.auth;
    this.friends = this.api.friends;
    this.messaging = this.api.messaging;
    this.snap = this.api.snap;
    this.browser = this.api.browser;
  }

  get page() {
    return this.#engine.page;
  }

  init(config = {}) {
    return this.#engine.init(config);
  }

  login(credentials) {
    return this.#auth.login(credentials);
  }

  logout() {
    return this.#auth.logout();
  }

  isLoggedIn() {
    return this.#auth.isLoggedIn();
  }

  getFriends(options = {}) {
    return this.#friends.getFriends(options);
  }

  getFriendStatus(options = {}) {
    return this.#status.getFriendStatus(options);
  }

  sendMessage(friendId, message, options = {}) {
    return this.#chat.sendMessage(friendId, message, options);
  }

  getConversation(friendId) {
    return this.#chat.getConversation(friendId);
  }

  watchMessages(options = {}) {
    return this.#watcher.watchMessages(options);
  }

  onEvent(callback) {
    if (typeof callback !== "function") {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "onEvent() requires a callback function.");
    }

    return this.#watcher.watchMessages({
      triggers: ["new_chat", "new_snap", "opened", "received", "delivered", "say_hi"],
      confirmConversation: false,
      fallbackPolling: false,
      onMessage: callback,
    });
  }

  sendSnap(options = {}) {
    return this.#snaps.sendSnap(options);
  }

  async close() {
    await this.#watcher.stop().catch(() => null);
    return this.#engine.close();
  }
}
