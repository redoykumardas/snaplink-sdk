import { ErrorCodes, wrapError } from "../../shared/errors/SnapchatError.js";

export class AuthService {
  constructor(engine) {
    this.engine = engine;
  }

  async login(credentials) {
    try {
      const bot = this.engine.requireBot();
      const result = await bot.login(credentials);
      this.engine.popupsHandled = true;

      if (this.engine.pendingSessionKey) {
        await bot.saveCookies(this.engine.pendingSessionKey);
      }

      return result;
    } catch (error) {
      await this.engine.debug.capture("auth-login-error").catch(() => null);
      throw wrapError(ErrorCodes.AUTH_FAILED, "Snapchat login failed", error);
    }
  }

  async logout() {
    try {
      const result = await this.engine.requireBot().logout();
      this.engine.popupsHandled = false;
      return result;
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Snapchat logout failed", error);
    }
  }

  async isLoggedIn() {
    try {
      return await this.engine.requireBot().isLogged();
    } catch (error) {
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to check login state", error);
    }
  }
}
