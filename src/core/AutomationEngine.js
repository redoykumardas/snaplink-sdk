import PrivateSnapchatEngine from "./PrivateSnapchatEngine.js";
import { DEFAULT_SDK_CONFIG, mergeConfig } from "../shared/config/defaults.js";
import { createLogger } from "../shared/logging/Logger.js";
import { ErrorCodes, SnapchatSDKError, wrapError } from "../shared/errors/SnapchatError.js";
import { ScreenshotService } from "../shared/debug/ScreenshotService.js";

export class AutomationEngine {
  constructor(config = {}) {
    this.config = mergeConfig(DEFAULT_SDK_CONFIG, config);
    this.logger = createLogger(config.logger);
    this.bot = null;
    this.initialized = false;
    this.pendingSessionKey = this.config.session?.key ?? null;
    this.popupsHandled = false;
    this.debug = new ScreenshotService(this);
  }

  async init(config = {}) {
    this.config = mergeConfig(this.config, config);
    this.logger = createLogger(this.config.logger);
    this.pendingSessionKey = this.config.session?.key ?? this.pendingSessionKey;

    try {
      this.bot = new PrivateSnapchatEngine(this.config.engineOptions ?? {});
      const launchOptions = this.resolveLaunchOptions(this.config);
      const state = await this.bot.launchSnapchat(launchOptions, this.pendingSessionKey);
      this.initialized = true;
      this.popupsHandled = false;
      return state;
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to initialize Snapchat browser session", error);
    }
  }

  resolveLaunchOptions(config) {
    const browser = config.browser ?? {};
    const launchOptions = { ...browser };

    if ("headless" in config) launchOptions.headless = config.headless;
    if (config.args) launchOptions.args = config.args;
    if (config.userDataDir) launchOptions.userDataDir = config.userDataDir;
    if (config.executablePath) launchOptions.executablePath = config.executablePath;

    return launchOptions;
  }

  requireBot() {
    if (!this.bot || !this.initialized) {
      throw new SnapchatSDKError(
        ErrorCodes.NOT_INITIALIZED,
        "SnapchatClient is not initialized. Call init() first."
      );
    }

    return this.bot;
  }

  async getReadyBot() {
    const bot = this.requireBot();

    if (!this.popupsHandled && bot.state === "app_ready") {
      try {
        await bot.handlePopup();
      } catch (error) {
        this.logger.debug("Popup handling skipped", error);
      } finally {
        this.popupsHandled = true;
      }
    }

    return bot;
  }

  async close() {
    if (!this.bot) return;
    try {
      await this.bot.closeBrowser();
    } finally {
      this.initialized = false;
      this.popupsHandled = false;
      this.bot = null;
    }
  }
}
