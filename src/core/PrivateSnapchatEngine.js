import puppeteer from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";

puppeteer.use(Stealth());

import fs from "fs";
import fsPromise from "fs/promises";
import { extractFromDOM } from "../extractors/chatExtractor.js";
import { ErrorCodes, SnapchatSDKError, wrapError } from "../shared/errors/SnapchatError.js";

function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

const lastTestedVersion = "v13.38.0";

export default class PrivateSnapchatEngine {
  constructor(options = {}) {
    this.page = null;
    this.browser = null;
    this.state = "idle";
    this.waiters = [];
    this.monitorStarted = false;
    this.redirectingToLogin = false;
    this.redirectingToWeb = false;
    this.recipientScrollCache = new Map();
    this.lastRecipientList = [];
    this.messageWatcherBridgeInstalled = false;
    this.messageWatchCallback = null;
    this.networkCallback = null;
    this.networkCDPSession = null;
    this._pendingRequests = null;
    this._lastSentMap = new Map();
    this.options = {
      waitMode: "forever",
      ...options,
    };
  }
  async launchSnapchat(obj, cookiefile) {
    try {
      const defaultArgs = [
        "--start-maximized",
        "--force-device-scale-factor=1",
        "--allow-file-access-from-files",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--enable-media-stream",
      ];

      const options = {
        ...obj,
        args: [...new Set([...(obj?.args || []), ...defaultArgs])]
      };

      this.browser = await puppeteer.launch(options);
      this.setState("launching");
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions("https://web.snapchat.com", ["camera", "microphone"]);
      await context.overridePermissions("https://www.snapchat.com", ["camera", "microphone"]);

      this.page = await context.newPage();
      await this.page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
      this.startStateMonitor();

      // Load cookies BEFORE any navigation
      if (cookiefile) {
        try {
          const cookiesString = await fsPromise.readFile(`./${cookiefile}-cookies.json`, "utf-8");
          const cookies = JSON.parse(cookiesString);
          let loadedCookies = 0;

          // Set cookies with proper domain
          for (const cookie of cookies) {
            try {
              if (!cookie.domain) cookie.domain = '.snapchat.com';
              await context.setCookie(cookie);
              loadedCookies++;
            } catch (e) {
              console.warn(`Skipped cookie "${cookie.name || "unknown"}": ${e.message}`);
            }
          }
          console.log(`Cookies loaded for ${cookiefile}: ${loadedCookies}/${cookies.length}`);
        } catch (error) {
          console.log(`No existing cookies for ${cookiefile}, will login manually`);
        }
      }

      // Navigate DIRECTLY to web app (not homepage) - cookies handle auth
      await this.page.goto("https://web.snapchat.com", {
        waitUntil: "domcontentloaded",
        timeout: 0
      });

      const readyState = await this.waitForState(["login_ready", "app_ready"]);
      console.log(`Snapchat ready state: ${readyState}, URL: ${this.page.url()}`);
      return readyState;

    } catch (error) {
      console.error(`Error while Starting Snapchat: ${error}`);
      this.setState("error", error);
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
      }
      throw error;
    }
  }

  startStateMonitor() {
    if (!this.page || this.monitorStarted) return;
    this.monitorStarted = true;

    const refresh = () => {
      this.refreshState().catch((error) => {
        if (this.isTransientNavigationError(error)) return;
        console.error("State monitor error:", error.message?.slice(0, 200));
        this.setState("error", error);
      });
    };

    this.browser.on("disconnected", () => {
      this.setState("closed", new Error("Browser disconnected"));
    });

    this.page.on("framenavigated", refresh);
    this.page.on("domcontentloaded", refresh);
    this.page.on("load", refresh);
    this.page.on("requestfailed", refresh);

    this.page.exposeFunction("__snapbotRefreshState", refresh).catch(() => { });

    const installStateObserver = () => {
      window.__snapbotInstallStateObserver = () => {
        if (window.__snapbotStateObserver) return;

        const root = document.documentElement || document.body;
        if (!root) {
          window.setTimeout(window.__snapbotInstallStateObserver, 100);
          return;
        }

        const notify = () => window.__snapbotRefreshState?.();
        window.__snapbotStateObserver = new MutationObserver(notify);
        window.__snapbotStateObserver.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        notify();
      };

      window.__snapbotInstallStateObserver();
    };

    this.page.evaluateOnNewDocument(installStateObserver).catch(() => { });
    this.page.evaluate(installStateObserver).catch(() => { });

    refresh();
  }

  setState(state, error = null) {
    if (this.state !== state) {
      console.log(`SnapchatEngine state: ${this.state} -> ${state}${error ? ` (${error.message?.slice(0, 100)})` : ""}`);
    }

    this.state = state;
    const terminalStates = ["blocked", "closed", "error"];
    const pending = this.waiters;
    this.waiters = [];

    for (const waiter of pending) {
      if (waiter.states.includes(state)) {
        waiter.resolve(state);
      } else if (terminalStates.includes(state)) {
        waiter.reject(error || new Error(`SnapchatEngine entered ${state} state`));
      } else {
        this.waiters.push(waiter);
      }
    }
  }

  async waitForState(states, timeoutMs = 0) {
    const wantedStates = Array.isArray(states) ? states : [states];
    const terminalStates = ["blocked", "closed", "error"];

    try {
      await this.refreshState();
    } catch (error) {
      if (!this.isTransientNavigationError(error)) throw error;
    }

    if (wantedStates.includes(this.state)) return this.state;
    if (terminalStates.includes(this.state)) {
      throw new Error(`SnapchatEngine is in ${this.state} state`);
    }

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`waitForState(${wantedStates.join(",")}) timed out after ${timeoutMs}ms`)), timeoutMs)
      ).catch(() => {});
      const waiter = new Promise((resolve, reject) => {
        this.waiters.push({ states: wantedStates, resolve, reject });
      });
      return Promise.race([waiter, timeoutPromise]);
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ states: wantedStates, resolve, reject });
    });
  }

  async refreshState() {
    if (!this.page) {
      this.setState("idle");
      return this.state;
    }

    if (this.page.isClosed()) {
      this.setState("closed", new Error("Page closed"));
      return this.state;
    }

    let state;

    try {
      state = await this.page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
      };

      const url = window.location.href;
      const host = window.location.hostname;
      const path = window.location.pathname;
      const bodyText = document.body?.innerText?.toLowerCase() || "";

      if (
        bodyText.includes("captcha") ||
        bodyText.includes("suspicious") ||
        bodyText.includes("temporarily disabled") ||
        bodyText.includes("verify your identity") ||
        bodyText.includes("security check")
      ) {
        return "blocked";
      }

      const hasAppUI = [
        "div.ReactVirtualized__Grid__innerScrollContainer",
        "div[role='listitem'] span[id^='title-']",
        "button[aria-label='Camera']",
        "button[data-testid='cameraButton']",
      ].some(selector => isVisible(document.querySelector(selector)));

      const isSnapchatWebApp = host === "web.snapchat.com" ||
        (host === "www.snapchat.com" && path.startsWith("/web"));

      if (isSnapchatWebApp && hasAppUI) return "app_ready";
      if (isSnapchatWebApp) return "loading";

      if (host === "accounts.snapchat.com" && path.includes("/welcome")) {
        return "post_login_ready";
      }

      if (host === "www.snapchat.com") return "public_page";

      const loginInputs = Array.from(document.querySelectorAll("input"));
      const hasLoginUI = loginInputs.some((input) => {
        const type = input.type?.toLowerCase();
        const id = input.id?.toLowerCase();
        const name = input.name?.toLowerCase();
        const autocomplete = input.autocomplete?.toLowerCase();

        return isVisible(input) &&
          (
            type === "password" ||
            type === "text" ||
            type === "email" ||
            type === "tel" ||
            id?.includes("username") ||
            id?.includes("password") ||
            name?.includes("username") ||
            name?.includes("password") ||
            autocomplete?.includes("username") ||
            autocomplete?.includes("current-password")
          );
      });

      if (host === "accounts.snapchat.com" && hasLoginUI) return "login_ready";
      if (url.includes("accounts.snapchat.com")) return "authenticating";

      return "loading";
      });
    } catch (error) {
      if (this.isTransientNavigationError(error)) {
        return this.state;
      }

      throw error;
    }

    this.setState(state);

    if (state === "public_page" && !this.redirectingToLogin) {
      this.redirectingToLogin = true;
      try {
        await this.page.goto("https://accounts.snapchat.com/accounts/v2/login", {
          waitUntil: "domcontentloaded",
          timeout: 0
        });
      } catch (error) {
        if (!this.isTransientNavigationError(error)) throw error;
      } finally {
        this.redirectingToLogin = false;
      }
    }

    if (state === "post_login_ready" && !this.redirectingToWeb) {
      this.redirectingToWeb = true;
      try {
        await this.page.goto("https://www.snapchat.com/web", {
          waitUntil: "domcontentloaded",
          timeout: 0
        });
      } catch (error) {
        if (!this.isTransientNavigationError(error)) throw error;
      } finally {
        this.redirectingToWeb = false;
      }
    }

    return this.state;
  }

  isTransientNavigationError(error) {
    const message = error?.message || "";
    return message.includes("Execution context was destroyed") ||
      message.includes("net::ERR_ABORTED") ||
      message.includes("Cannot find context with specified id") ||
      message.includes("Navigating frame was detached") ||
      message.includes("Protocol error") && message.includes("Runtime.callFunctionOn");
  }

  async login(credentials) {
    const { username, password } = credentials;
    if (!username || !password) {
      throw new SnapchatSDKError(ErrorCodes.INVALID_INPUT, "Credentials cannot be empty");
    }

    try {
      console.log("Waiting for username form...");
      await this.waitForState("login_ready");

      // Try standard selectors first, then fall back to dynamic scanning
      let usernameInput = await this.page.$("#username, #userId, input[name='username'], input[type='email']");

      if (!usernameInput) {
        await this.page.waitForFunction(
          () => {
            const inputs = document.querySelectorAll('input');
            for (const input of inputs) {
              const type = input.type?.toLowerCase();
              if (type === 'text' || type === 'email' || type === 'tel' || !type) {
                const rect = input.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return true;
              }
            }
            return false;
          },
          { timeout: 15000 }
        );

        usernameInput = await this.page.evaluateHandle(() => {
          const inputs = document.querySelectorAll('input');
          for (const input of inputs) {
            const type = input.type?.toLowerCase();
            if (type === 'text' || type === 'email' || type === 'tel' || !type) {
              const rect = input.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return input;
            }
          }
          return null;
        });
      }

      if (!usernameInput || (usernameInput.asElement ? !usernameInput.asElement() : false)) {
        await this.page.screenshot({ path: "debug-login-fail.png" });

        // Check if CAPTCHA is blocking
        const hasCaptcha = await this.page.evaluate(() => {
          return document.body.textContent.toLowerCase().includes("verify") ||
                 document.querySelector("iframe[src*='captcha'], iframe[src*='recaptcha']");
        });

        if (hasCaptcha) {
          throw new SnapchatSDKError(ErrorCodes.CAPTCHA_DETECTED, "CAPTCHA detected on login page");
        }

        throw new SnapchatSDKError(ErrorCodes.LOGIN_INPUT_NOT_FOUND, "Username input not found on login page");
      }

      console.log("Entering username...");
      await usernameInput.click();
      await this.page.keyboard.type(username, { delay: 15 });

      await this.page.keyboard.press("Enter");
      this.setState("authenticating");

      console.log("Navigated to password page, URL:", this.page.url());

    } catch (e) {
      if (e instanceof SnapchatSDKError) throw e;
      console.log("Username field error:", e.message);
      throw wrapError(ErrorCodes.LOGIN_INPUT_NOT_FOUND, "Failed to fill username field", e);
    }

    // --- Password page ---
    try {
      console.log("Waiting for password field...");
      await this.page.waitForSelector("#password", { visible: true, timeout: 0 });
      await this.page.click("#password");
      await this.page.keyboard.type(password, { delay: 15 });
      console.log("Password field filled.");

      await this.page.keyboard.press("Enter");
      this.setState("authenticating");

      await this.waitForState("app_ready");
      console.log("Login complete, URL:", this.page.url());

    } catch (e) {
      console.log("Password field loading error:", e.message);
      throw wrapError(ErrorCodes.AUTH_FAILED, "Failed to complete password step", e);
    }

    await this.handlePopup();
  }
  async isLogged() {
    await this.refreshState();
    const url = this.page.url();
    console.log("Checking login status, URL:", url);

    if (this.state === "app_ready") {
      console.log("Already logged in");
      return true;
    }

    return false;
  }

  async handlePopup() {
    await this.waitForState("app_ready");
    try {
      // Check for "Not now" button (short timeout)
      await this.page.waitForFunction(
        () => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent?.toLowerCase().includes('not now')) return true;
          }
          return false;
        },
        { timeout: 5000 }
      );

      const notNowBtn = await this.page.evaluateHandle(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.toLowerCase().includes('not now')) return btn;
        }
        return null;
      });

      if (notNowBtn && notNowBtn.asElement()) {
        await notNowBtn.asElement().click();
        console.log("Clicked 'Not now'");

        // After dismissing popup, ensure the friend list is loaded again
        await this.page.waitForSelector('div[role="listitem"], button[data-testid="cameraButton"], button[aria-label="Camera"]', { timeout: 15000 });
        console.log("UI ready after popup");
      }
    } catch (e) {
      console.log("No popup found or already handled");
    }
  }

  async startMessageWatcher(options = {}, callback) {
    await this.waitForState("app_ready");

    this.messageWatchCallback = callback;

    if (!this.messageWatcherBridgeInstalled) {
      await this.page.exposeFunction("__snapchatSdkMessageEvent", (event) => {
        if (typeof this.messageWatchCallback === "function") {
          this.messageWatchCallback(event);
        }
      });
      this.messageWatcherBridgeInstalled = true;
    }

    await this.page.waitForSelector(
      "div.ReactVirtualized__Grid__innerScrollContainer, div[role='listitem']",
      { timeout: 60000 }
    );

    await this.page.evaluate(({ includeExisting, triggers }) => {
      if (window.__snapchatSdkMessageWatcher?.observer) {
        window.__snapchatSdkMessageWatcher.observer.disconnect();
        window.clearTimeout(window.__snapchatSdkMessageWatcher.timer);
      }

      const watcher = {
        seen: new Map(),
        hasScanned: false,
        includeExisting,
        timer: null,
        observer: null,
        triggers: new Set((Array.isArray(triggers) ? triggers : []).map((trigger) => {
          return String(trigger || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
        })),
      };

      const normalize = (value) => String(value || "").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
      };

      const parseActivity = (text) => {
        const lower = text.toLowerCase();
        if (lower.includes("say hi")) return { statusType: "say_hi", trigger: "say_hi" };
        if (lower.includes("new chat")) return { statusType: "new_chat", trigger: "new_chat" };
        if (lower.includes("new snap")) return { statusType: "new_snap", trigger: "new_snap" };
        if (lower.includes("unread")) return { statusType: "received", trigger: "unread" };
        if (lower.includes("received")) return { statusType: "received", trigger: "received" };
        if (lower.includes("opened")) return { statusType: "opened", trigger: "opened" };
        if (lower.includes("delivered")) return { statusType: "delivered", trigger: "delivered" };
        return { statusType: null, trigger: null };
      };

      const extractRow = (row) => {
        const title = row.querySelector("span[id^='title-'], [id^='title-']");
        if (!title) return null;

        const id = normalize(title.id).replace(/^title-/, "");
        const name = normalize(title.textContent);
        const text = normalize(row.innerText || row.textContent);
        const activity = parseActivity(text);
        const statusContainer = row.querySelector(`#status-${CSS.escape(id)}`);
        const statusText = normalize(statusContainer?.parentElement?.innerText || text);

        return {
          kind: "message_candidate",
          source: "dom",
          trigger: activity.trigger,
          friendId: id,
          id,
          name,
          status: {
            type: activity.statusType,
            time: (statusText.match(/\b\d+\s?[mhdw]\b/i) || [null])[0],
            streak: statusText.includes("🔥") ? "🔥" : null,
          },
          statusText,
          previewText: text,
          detectedAt: Date.now(),
        };
      };

      const scan = () => {
        const rows = Array.from(document.querySelectorAll("div[role='listitem'], [role='option']"))
          .filter(isVisible);

        for (const row of rows) {
          const event = extractRow(row);
          if (!event?.friendId) continue;

          const key = [
            event.friendId,
            event.status?.type ?? "",
            event.statusText,
            event.previewText,
          ].join(":");

          const previousKey = watcher.seen.get(event.friendId);
          const isFirstVisibleRow = watcher.hasScanned && !previousKey;
          watcher.seen.set(event.friendId, key);

          const isTriggeredStatus = event.trigger && watcher.triggers.has(event.trigger);
          const isNewFriend = isFirstVisibleRow && watcher.triggers.has("new_friend");
          const shouldEmit =
            isTriggeredStatus &&
            (
              (watcher.includeExisting && !watcher.hasScanned) ||
              (watcher.hasScanned && (!previousKey || previousKey !== key))
            );

          if (shouldEmit) {
            window.__snapchatSdkMessageEvent?.(event);
          }

          if (isNewFriend) {
            window.__snapchatSdkMessageEvent?.({
              ...event,
              trigger: "new_friend",
              status: {
                ...event.status,
                type: null,
              },
            });
          }
        }

        watcher.hasScanned = true;
      };

      const scheduleScan = () => {
        window.clearTimeout(watcher.timer);
        watcher.timer = window.setTimeout(scan, 250);
      };

      watcher.observer = new MutationObserver(scheduleScan);
      watcher.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });

      window.__snapchatSdkMessageWatcher = watcher;
      scan();
    }, {
      includeExisting: Boolean(options.includeExisting),
      triggers: Array.isArray(options.triggers) ? options.triggers : [],
    });

    console.log("Message watcher started");
  }

  async stopMessageWatcher() {
    this.messageWatchCallback = null;

    if (!this.page || this.page.isClosed()) return;

    await this.page.evaluate(() => {
      if (window.__snapchatSdkMessageWatcher?.observer) {
        window.__snapchatSdkMessageWatcher.observer.disconnect();
        window.clearTimeout(window.__snapchatSdkMessageWatcher.timer);
      }

      window.__snapchatSdkMessageWatcher = null;
    }).catch(() => { });

    console.log("Message watcher stopped");
  }

  async startWebSocketWatcher(callback) {
    await this.waitForState("app_ready");
    this.networkCallback = callback;

    if (!this.page || this.page.isClosed()) return;

    const client = await this.page.createCDPSession();
    await client.send("Network.enable");

    client.on("Network.requestWillBeSent", (event) => {
      this._pendingRequests ??= new Map();
      this._pendingRequests.set(event.requestId, event.request.url);
    });

    client.on("Network.loadingFinished", async (event) => {
      if (!this.networkCallback) return;
      const url = this._pendingRequests?.get(event.requestId);
      if (!url || (!url.includes("snapchat.com") && !url.includes("snapkit"))) return;

      try {
        const { body, base64Encoded } = await client.send("Network.getResponseBody", {
          requestId: event.requestId,
        });
        const text = base64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
        const eventData = this.#parseNetworkEvent(text);
        if (eventData) this.networkCallback(eventData);
      } catch {}
    });

    this.networkCDPSession = client;
    console.log("WebSocket watcher started");
  }

  async stopWebSocketWatcher() {
    this.networkCallback = null;
    if (this.networkCDPSession) {
      try { await this.networkCDPSession.detach(); } catch {}
      this.networkCDPSession = null;
    }
    this._pendingRequests = null;
    console.log("WebSocket watcher stopped");
  }

  #parseNetworkEvent(body) {
    const lower = body.toLowerCase();

    const PATTERNS = [
      { keyword: "say hi", type: "say_hi" },
      { keyword: "new chat", type: "new_chat" },
      { keyword: "new snap", type: "new_snap" },
      { keyword: "opened", type: "opened" },
      { keyword: "received", type: "received" },
      { keyword: "delivered", type: "delivered" },
    ];

    let matchType = null;
    for (const { keyword, type } of PATTERNS) {
      if (lower.includes(keyword)) { matchType = type; break; }
    }
    if (!matchType) return null;

    const uuidRegex = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi;
    const uuids = [...body.matchAll(uuidRegex)].map(m => m[0]);
    const friendId = uuids.length > 0 ? uuids[0] : null;

    let name = null;
    const multiWord = body.match(/[A-ZÀ-Ü][a-zà-ü]+(?:\s[A-ZÀ-Ü][a-zà-ü]+){1,3}/g);
    if (multiWord) {
      const skip = new Set([
        "openedourstorycreatorprofile", "tappedlensprofile",
        "trendingviralspotlight", "openedourstory",
        "ourstorycreatorprofile", "ourstory",
      ]);
      for (const c of [...new Set(multiWord)]) {
        const key = c.toLowerCase().replace(/\s/g, "");
        if (c.length >= 5 && c.length <= 40 && !skip.has(key)) { name = c; break; }
      }
    }
    if (!name) {
      const single = body.match(/[A-ZÀ-Ü][a-zà-ü]{3,30}/g);
      if (single) {
        const skip = new Set(["Openedourstorycreatorprofile", "Tappedlensprofile", "Trendingviralspotlight"]);
        for (const s of [...new Set(single)]) {
          if (s.length >= 4 && !skip.has(s)) { name = s; break; }
        }
      }
    }
    if (!name) {
      const fallback = body.match(/(?:^|[^\w])@?([\w.]{4,30})/g);
      if (fallback) {
        for (const f of fallback) {
          const t = f.replace(/^[^\w]+/, "").trim();
          if (t.length >= 4 && !/^\d+$/.test(t) && !/^[\da-f]{8,}$/i.test(t) && !t.startsWith("http") && !t.startsWith("https")) {
            name = t.startsWith("@") ? t.slice(1) : t;
            break;
          }
        }
      }
    }
    // Final polish: reject clearly wrong names
    if (name) {
      const trash = new Set(["story", "phttps", "laugh", "trend", "reels", "nature", "fear", "wisdom", "titanic", "barbershop"]);
      if (trash.has(name.toLowerCase().replace(/[\s_]/g, ""))) name = null;
    }

    const timeMatch = body.match(/\b(\d+\s?[mhdw])\b/i);
    const time = timeMatch ? timeMatch[0] : null;

    if (!friendId && !name) return null;

    return {
      kind: "websocket_event",
      source: "network",
      trigger: matchType,
      friendId: friendId || null,
      name: name || null,
      status: { type: matchType, time, streak: null },
      detectedAt: Date.now(),
    };
  }

  async waitForSnapPreview(timeout = 15000) {
    await this.page.waitForSelector('#snap-preview-container', { timeout, visible: true });
    console.log("Preview screen detected");
    await delay(1000);
    await this.screenshot({ path: "debug-preview-ready.png" });
  }

  async tryUploadSnapImage(imagePath) {
    const tryFileUpload = async (timeout) => {
      const input = await this.page.$('input[type="file"]');
      if (!input) return false;
      await input.uploadFile(imagePath);
      await this.waitForSnapPreview(timeout);
      return true;
    };

    const tryChooserUpload = async (timeout) => {
      const chooserPromise = this.page.waitForFileChooser({ timeout: 15000 }).catch(() => null);
      const clicked = await this.page.evaluate(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };

        const label = (el) => [
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
        ].filter(Boolean).join(" ").toLowerCase();

        const candidates = Array.from(document.querySelectorAll('button, [role="button"], label, div, span'))
          .filter(el => visible(el) && /upload|drag.*drop|drop.*upload/.test(label(el)))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.bottom + br.right) - (ar.bottom + ar.right);
          });

        const target = candidates[0];
        if (!target) return false;
        target.click();
        return true;
      });

      if (!clicked) return false;
      const chooser = await chooserPromise;
      if (!chooser) return false;
      await chooser.accept([imagePath]);
      await this.waitForSnapPreview(timeout);
      return true;
    };

    // Attempt 1: Direct file input upload
    const input = await this.page.$('input[type="file"]');
    if (input) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const ok = await tryFileUpload(attempt === 0 ? 15000 : 30000);
          if (ok) { console.log("Image uploaded through file input"); return true; }
        } catch (error) {
          console.warn(`File input attempt ${attempt + 1} failed:`, error.message);
        }
      }
    }

    // Attempt 2: Upload dialog (click upload button, wait for file chooser)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ok = await tryChooserUpload(attempt === 0 ? 15000 : 30000);
        if (ok) { console.log("Image uploaded through upload chooser"); return true; }
      } catch (error) {
        console.warn(`Upload chooser attempt ${attempt + 1} failed:`, error.message);
      }
      await delay(1000);
    }

    // Attempt 3: Fallback — replace preview image directly via DOM
    console.log("Trying fallback: replace preview image via DOM");
    await this.replacePreviewImage(imagePath);
    const previewExists = await this.page.$('#snap-preview-container').catch(() => null);
    return !!previewExists;
  }

  async replacePreviewImage(imagePath) {
    try {
      const imageBase64 = await fsPromise.readFile(imagePath, "base64");
      const imageData = `data:image/png;base64,${imageBase64}`;
      const replaced = await this.page.evaluate((imgData) => {
        const previewImg = document.querySelector('#snap-preview-container img');
        if (!previewImg) return false;
        previewImg.src = imgData;
        return true;
      }, imageData);

      if (replaced) {
        console.log("Custom image added");
      } else {
        console.warn("Preview image element not found for replacement");
      }
    } catch (err) {
      console.warn("Could not replace image:", err.message);
    }
  }

  async addSnapCaption(caption, position) {
    if (!caption) return;

    const captionBtnClicked = await this.page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const btns = Array.from(document.querySelectorAll('button')).filter(visible);
      for (const btn of btns) {
        const title = btn.getAttribute('title') || '';
        const label = btn.getAttribute('aria-label') || '';
        const text = btn.textContent?.trim() || '';
        if (`${title} ${label} ${text}`.toLowerCase().includes('caption')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!captionBtnClicked) {
      console.warn("Could not find 'Add a caption' button");
      await this.screenshot({ path: "debug-caption-btn-missing.png" }).catch(() => {});
      return;
    }

    console.log("Clicked 'Add a caption' - waiting for input");
    await delay(1500);

    let captionInput = await this.page.$('[contenteditable="true"]');
    if (!captionInput) {
      captionInput = await this.page.$('textarea');
    }

    if (!captionInput) {
      console.warn("Caption input field not found");
      await this.screenshot({ path: "debug-caption-input-missing.png" });
      return;
    }

    await captionInput.click();
    await captionInput.type(caption, { delay: 100 });
    console.log("Caption typed");

    if (position !== undefined && position !== null) {
      await delay(500);
      await captionInput.click();
      const direction = position < 0 ? 'ArrowUp' : 'ArrowDown';
      const steps = Math.min(Math.abs(Math.round(position / 15)), 200);
      for (let i = 0; i < steps; i++) {
        await this.page.keyboard.press(direction);
        await delay(30);
      }
      console.log(`Caption position adjusted: ${direction} x ${steps}`);
    }
  }

  async captureSnap(obj) {
    await this.waitForState("app_ready");
    try {
      console.log("Attempting to open camera...");
      const cameraOpened = await this.page.evaluate(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };

        const attrSelectors = [
          'button[aria-label="Camera"]',
          'button[data-testid="cameraButton"]',
          'button[aria-label="Take a Snap"]',
          '[role="button"][aria-label="Camera"]',
          '[role="button"][aria-label*="camera" i]',
          'a[aria-label*="camera" i]',
        ];
        for (const sel of attrSelectors) {
          const el = document.querySelector(sel);
          if (el && visible(el)) { el.click(); return true; }
        }

        const allCandidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[tabindex]'));
        for (const el of allCandidates) {
          if (!visible(el)) continue;
          const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").toLowerCase();
          if (label.includes("camera")) { el.click(); return true; }
        }

        const bottomCenterBtns = allCandidates.filter(el => {
          const r = el.getBoundingClientRect();
          const isBottom = r.y + r.height > window.innerHeight - 120;
          const isCircle = Math.abs(r.width - r.height) < 15 && r.width > 35 && r.width < 80;
          const noText = !(el.textContent || "").trim();
          return isBottom && isCircle && noText;
        });
        if (bottomCenterBtns.length) { bottomCenterBtns[0].click(); return true; }

        const sidebarBtns = allCandidates.filter(el => {
          const r = el.getBoundingClientRect();
          return r.x < 80 && r.y > 0 && r.width > 0;
        }).slice(0, 5);
        const svgBtn = sidebarBtns.find(el => el.querySelector('svg') && !(el.textContent || "").trim());
        if (svgBtn) { svgBtn.click(); return true; }

        return false;
      });
      if (!cameraOpened) {
        await this.screenshot({ path: "debug-camera-button-missing.png" }).catch(() => {});
        throw new SnapchatSDKError(ErrorCodes.SNAP_CAMERA_ERROR, "Could not open camera button");
      }
      console.log("Camera button clicked – waiting for camera UI");

      await this.page.waitForFunction(
        () => {
          const hasInput = document.querySelector('input[type="file"]');
          const hasLabels = Array.from(document.querySelectorAll('button, label, div'))
            .some(el => /upload|camera|drag/i.test(el.textContent || ''));
          const hasVideo = document.querySelector('video#local-video, video');
          return hasInput || hasLabels || (hasVideo && hasVideo.readyState >= 2 && hasVideo.videoWidth > 0);
        },
        { timeout: 15000 }
      ).catch(() => console.warn("Camera UI wait timed out, proceeding anyway"));

      await delay(500);

      if (obj.path && await this.tryUploadSnapImage(obj.path)) {
        await this.addSnapCaption(obj.caption, obj.position);
        console.log("Snap ready on preview screen");
        return;
      }

      try {
        await this.page.waitForFunction(
          () => {
            const video = document.querySelector('video#local-video, video');
            return video && video.readyState >= 2 && video.videoWidth > 0;
          },
          { timeout: 15000 }
        );
        console.log("Camera video active");
        await delay(2000);
        await this.screenshot({ path: "debug-camera-active.png" });
      } catch (error) {
        if (!obj.path) throw error;
        console.warn("Camera video did not become active; trying image snap fallback:", error.message);
        await this.screenshot({ path: "debug-camera-no-video.png" }).catch(() => { });
      }

      // Capture button
      console.log("Looking for capture button...");
      let captureClicked = false;
      const captureTarget = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const candidates = [];

        for (const btn of btns) {
          const rect = btn.getBoundingClientRect();
          const isCircle = Math.abs(rect.width - rect.height) < 10 && rect.width > 50;
          const noText = !btn.innerText.trim();
          const isBottomCenter = rect.y + rect.height > window.innerHeight - 150;
          if (isCircle && noText && isBottomCenter) {
            candidates.push({
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              area: rect.width * rect.height,
            });
          }
        }

        candidates.sort((a, b) => b.area - a.area);
        return candidates[0] || null;
      });

      if (captureTarget) {
        await this.page.mouse.move(captureTarget.x, captureTarget.y);
        await this.page.mouse.down();
        await delay(80);
        await this.page.mouse.up();
        captureClicked = true;
      }

      if (!captureClicked) {
        const fallbackSelectors = [
          'button[aria-label="Capture"]',
          'button[data-testid="captureButton"]',
        ];
        for (const sel of fallbackSelectors) {
          const btn = await this.page.$(sel);
          if (btn) {
            await btn.click();
            captureClicked = true;
            console.log(`Capture clicked via fallback: ${sel}`);
            break;
          }
        }
      }
      if (!captureClicked) throw new Error("Capture button not clickable");
      console.log("Capture clicked – waiting for preview screen");

      await this.waitForSnapPreview(15000);

      if (obj.path) {
        await this.replacePreviewImage(obj.path);
      }

      await this.addSnapCaption(obj.caption, obj.position);
      console.log("Snap ready on preview screen");
    } catch (error) {
      console.error("captureSnap error:", error);
      await this.screenshot({ path: "captureSnap-error.png" }).catch(() => { });
      throw error;
    }
  }

  async send(person) {
    await this.waitForState("app_ready");
    try {
      await this.openSnapSendPanel();
      const audience = person.toLowerCase();

      const clicked = await this.page.evaluate((targetAudience) => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const normalize = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

        const allSections = Array.from(document.querySelectorAll("section, div[role='region'], [class*='section'], li[role='separator'], h1, h2, h3, h4, h5, h6, span, div"))
          .filter(el => {
            const text = el.textContent?.trim() || "";
            const isSectionHeader = /^(best|my|friend|group)/i.test(text);
            return isSectionHeader && visible(el);
          });

        const sectionLabels = {
          bestfriends: ["best", "bestfriend", "best friend", "bestfriends", "best friends"],
          groups: ["group", "groups"],
          friends: ["my friend", "my friends", "friends", "friend", "all friends"],
        };

        const validLabels = sectionLabels[targetAudience];
        if (!validLabels) return 0;

        const targetSection = allSections.find(section => {
          const text = normalize(section.textContent || "");
          return validLabels.some(label => text.includes(normalize(label)));
        });

        if (!targetSection) return 0;

        const sectionRoot = targetSection.closest("div, li, section") || targetSection;
        const items = Array.from(sectionRoot.querySelectorAll('li, [role="listitem"], [role="option"], [role="checkbox"]'))
          .filter(visible);

        for (const item of items) {
          const clickTarget = item.querySelector('[role="checkbox"], button, [role="button"], label, input') || item;
          clickTarget.click();
        }

        return items.length;
      }, audience);

      if (clicked === 0) {
        throw new Error(`No snap recipients found for ${person}`);
      }

      console.log(`Selected ${clicked} recipient(s) for "${person}"`);
      await this.clickSnapSubmit();
    } catch (error) {
      console.error("Error while sending snap", error);
      throw error;
    }
  }

  async openSnapSendPanel() {
    const clicked = await this.page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const selectors = [
        'button[aria-label*="Send" i]',
        'button[title*="Send" i]',
      ];

      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button && visible(button)) {
          button.click();
          return true;
        }
      }

      const button = Array.from(document.querySelectorAll("button"))
        .find(btn => visible(btn) && /send|next/i.test(`${btn.textContent} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`));

      if (!button) return false;
      button.click();
      return true;
    });

    if (!clicked) {
      throw new Error("Snap send panel button not found");
    }

    await this.page.waitForFunction(
      () => {
        const items = document.querySelectorAll('li, [role="listitem"], [role="option"]');
        return items.length > 0;
      },
      { timeout: 10000 }
    ).catch(() => console.warn("Send panel list items did not appear"));

    await delay(500);
  }

  async clickSnapSubmit() {
    const clicked = await this.page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find(btn => visible(btn) && btn.type === "submit" && !btn.disabled)
        || buttons.find(btn => visible(btn) && !btn.disabled && /^send$/i.test(btn.textContent.trim()));

      if (!button) return false;
      button.click();
      return true;
    });

    if (!clicked) {
      throw new Error("Snap submit button not found");
    }

    await delay(2000);
  }

  async sendToFriends(recipients) {
    await this.waitForState("app_ready");
    const targets = recipients
      .map((recipient) => {
        if (typeof recipient === "string") return { id: recipient.trim(), name: recipient.trim() };
        const rawId = recipient?.id ?? recipient?.userId ?? recipient?.username ?? recipient?.name;
        const rawName = recipient?.name ?? recipient?.displayName ?? recipient?.username ?? recipient?.id;
        return {
          id: (rawId || "").trim(),
          name: (rawName || "").trim(),
        };
      })
      .filter(target => target.id.length > 0 || target.name.length > 0);

    if (!targets.length) {
      throw new Error("sendToFriends requires at least one friend id or name");
    }

    for (const target of targets) {
      if (this.recipientScrollCache.size && target.id && target.name === target.id) {
        const cached = this.recipientScrollCache.get(target.id);
        if (cached) target.name = cached.name || cached.displayName || target.id;
      }
    }

    await this.openSnapSendPanel();

    const selected = new Set();
    let stable = 0;
    let previousVisibleKey = "";
    let scrollDownAttempts = 0;

    while (selected.size < targets.length) {
      const result = await this.page.evaluate((targetList, selectedKeys) => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };

        const normalize = (value) => String(value || "").trim().toLowerCase();
        const getRowData = (row) => {
          const title = row.querySelector("span[id^='title-'], [id^='title-']");
          const id = title?.id?.replace(/^title-/, "") || "";
          const name = title?.textContent?.trim() || row.textContent?.trim() || "";
          const dataAttr = row.querySelector('[data-user-id], [data-id], [data-friend-id], [data-username]');
          const dataId = dataAttr?.getAttribute('data-user-id')
            || dataAttr?.getAttribute('data-id')
            || dataAttr?.getAttribute('data-friend-id')
            || "";
          return { id, dataId, name, text: row.textContent || "", html: row.innerHTML };
        };

        const matches = (row, target) => {
          const data = getRowData(row);
          const id = normalize(data.id);
          const dataId = normalize(data.dataId);
          const name = normalize(data.name);
          const text = normalize(data.text);
          const targetId = normalize(target.id);
          const targetName = normalize(target.name);

          return Boolean(
            (targetId && id && id === targetId) ||
            (targetId && dataId && dataId === targetId) ||
            (targetId && text.includes(targetId)) ||
            (targetId && data.html.includes(target.id)) ||
            (targetName && name && name === targetName) ||
            (targetName && text.includes(targetName))
          );
        };

        const findScrollable = () => {
          const isScrollable = (el) => {
            const overflow = window.getComputedStyle(el).overflowY;
            return (overflow === "scroll" || overflow === "auto") && el.scrollHeight > el.clientHeight + 5;
          };
          const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='listbox'], [role='grid'], ul, div"))
            .filter(el => isScrollable(el) || el.scrollHeight > el.clientHeight + 10);
          return candidates.find(el => /send|friend|best|group/i.test(el.textContent || ""))
            || candidates.find(el => el.querySelectorAll('li, [role="listitem"]').length > 2)
            || candidates[0]
            || document.scrollingElement;
        };

        const rows = Array.from(document.querySelectorAll("li, [role='listitem'], [role='option']"))
          .filter(visible);
        const clicked = [];

        for (const target of targetList) {
          const key = `${target.id || ""}:${target.name || ""}`;
          if (selectedKeys.includes(key)) continue;

          const row = rows.find(item => matches(item, target));
          if (!row) continue;

          const clickTarget = row.querySelector('[role="checkbox"], button, [role="button"], label, input') || row;
          clickTarget.click();
          clicked.push(key);
        }

        const visibleKey = rows.map(row => row.textContent.trim()).join("|").slice(0, 5000);
        const container = findScrollable();
        if (!container) return { clicked, moved: false, visibleKey };

        const before = container.scrollTop;
        const rect = container.getBoundingClientRect();
        const amount = Math.max(700, Math.floor(container.clientHeight * 1.2));
        const direction = window.__sendingScrollUp ? -1 : 1;
        container.scrollBy(0, amount * direction);
        container.dispatchEvent(new Event("scroll", { bubbles: true }));

        return {
          clicked,
          moved: container.scrollTop !== before,
          visibleKey,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }, targets, Array.from(selected));

      for (const key of result.clicked) {
        selected.add(key);
        if (key.includes(":")) {
          const parts = key.split(":");
          const keyAlt = parts[0] || parts[1];
          if (keyAlt && !selected.has(keyAlt)) selected.add(keyAlt);
        }
      }

      if (Number.isFinite(result.x) && Number.isFinite(result.y)) {
        await this.page.mouse.move(result.x, result.y);
      }

      if (result.clicked.length || (result.moved && result.visibleKey !== previousVisibleKey)) {
        stable = 0;
        if (result.moved) scrollDownAttempts++;
      } else {
        stable++;
      }

      if (stable >= 3 && scrollDownAttempts > 10 && !window.__sendingScrollUp) {
        window.__sendingScrollUp = true;
        stable = 0;
        scrollDownAttempts = 0;
        console.log("Switching to scroll-up direction");
      }

      if (stable >= 5) break;

      previousVisibleKey = result.visibleKey;
      await delay(400);
    }

    if (selected.size < targets.length) {
      const missing = targets
        .filter(target => {
          const key = `${target.id || ""}:${target.name || ""}`;
          const keyAlt = target.id || target.name;
          return !selected.has(key) && !selected.has(keyAlt);
        })
        .map(target => target.name || target.id);
      await this.screenshot({ path: "debug-sendToFriends-missing.png" }).catch(() => {});
      throw new Error(`Snap recipients not found: ${missing.join(", ")}`);
    }

    await this.clickSnapSubmit();
    console.log(`Snap sent to ${selected.size} friend(s)`);
  }

  async closeBrowser() {
    if (!this.browser) {
      console.log("Snapchat browser was not started");
      return;
    }

    await this.browser.close();
    console.log("Snapchat closed");
  }

  async screenshot(obj) {
    await this.page.screenshot(obj);
  }

  async logout() {
    try {
      console.log("Attempting to log out...");
      const profileBtn = await this.page.waitForSelector('#downshift-0-toggle-button', { timeout: 10000 });
      await profileBtn.click();
      await delay(1000);
      await this.page.waitForSelector('#downshift-0-menu', { timeout: 5000 });
      const logoutOption = await this.page.$('#downshift-0-item-9');
      if (logoutOption) {
        await logoutOption.click();
        console.log("Log out clicked");
      } else {
        const logoutByText = await this.page.evaluateHandle(() => {
          const items = Array.from(document.querySelectorAll('#downshift-0-menu [role="option"]'));
          return items.find(el => el.innerText.trim() === 'Log out') || null;
        });
        if (logoutByText && logoutByText.asElement()) {
          await logoutByText.asElement().click();
          console.log("Log out via text");
        } else {
          throw new Error("Log out option not found");
        }
      }
      await delay(5000);
      console.log("Logged out successfully");
    } catch (error) {
      console.error("Logout error:", error);
      await this.screenshot({ path: "logout-error.png" });
    }
  }

  async wait(time) {
    return new Promise(function (resolve) {
      setTimeout(resolve, time);
    });
  }
  //beta
  async openFriendRequests() {
    await this.waitForState("app_ready");
    await this.page.waitForSelector('button[title="View friend requests"]');
    const requests = await this.page.$('button[title="View friend requests"]');
    await requests.click();
  }

  async listRecipients(limit = null, timeoutMs = 120000) {
    await this.waitForState("app_ready");
    const targetCount = Number.isInteger(limit) && limit > 0 ? limit : null;
    console.log("Waiting for friend list (dynamic)...");

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), timeoutMs);

    try {
      await this.page.waitForSelector(
        "div.ReactVirtualized__Grid__innerScrollContainer",
        { timeout: 30000 }
      );

      await this.page.waitForFunction(() => {
        return document.querySelectorAll("div[role='listitem'] span[id^='title-']").length > 0;
      }, { timeout: 30000 });

      const recipients = new Map();
      this.recipientScrollCache.clear();
      this.lastRecipientList = [];
      let prevSize = 0;
      let stable = 0;
      let previousVisibleKey = "";

      while (!ac.signal.aborted) {
        const snapshot = await this.page.evaluate(() => {
          const findScrollable = () => {
            const title = document.querySelector("div[role='listitem'] span[id^='title-']");
            let node = title?.parentElement;

            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) return node;
              node = node.parentElement;
            }

            const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
            return candidates.find(el =>
              el.scrollHeight > el.clientHeight + 10 &&
              el.querySelector("div[role='listitem'] span[id^='title-']")
            ) || document.scrollingElement;
          };

          const container = findScrollable();
          const scrollTop = container?.scrollTop ?? 0;
          const friends = Array.from(
            document.querySelectorAll("div[role='listitem'] span[id^='title-']")
          )
            .map(el => ({
              id: el.id.replace("title-", ""),
              name: el.textContent.trim()
            }))
            .filter(user => user.name.toLowerCase() !== "my ai");

          return { friends, scrollTop };
        });

        for (const user of snapshot.friends) {
          if (!recipients.has(user.id)) {
            const cachedUser = {
              ...user,
              index: recipients.size,
              scrollTop: snapshot.scrollTop
            };
            recipients.set(user.id, cachedUser);
            this.recipientScrollCache.set(user.id, cachedUser);
          }
        }

        console.log("Current loaded:", recipients.size);

        if (targetCount && recipients.size >= targetCount) break;

        const scrollResult = await this.page.evaluate(() => {
          const findScrollable = () => {
            const title = document.querySelector("div[role='listitem'] span[id^='title-']");
            let node = title?.parentElement;

            while (node && node !== document.body) {
              if (node.scrollHeight > node.clientHeight + 10) return node;
              node = node.parentElement;
            }

            const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
            return candidates.find(el =>
              el.scrollHeight > el.clientHeight + 10 &&
              el.querySelector("div[role='listitem'] span[id^='title-']")
            ) || document.scrollingElement;
          };

          const container = findScrollable();
          if (!container) return { moved: false };

          const visibleIds = Array.from(
            document.querySelectorAll("div[role='listitem'] span[id^='title-']")
          ).map(el => el.id).join("|");
          const before = container.scrollTop;
          const amount = Math.max(900, Math.floor(container.clientHeight * 1.35));
          container.scrollBy(0, amount);
          container.dispatchEvent(new Event("scroll", { bubbles: true }));

          const rect = container.getBoundingClientRect();
          return {
            moved: container.scrollTop !== before,
            before,
            after: container.scrollTop,
            max: container.scrollHeight - container.clientHeight,
            visibleIds,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        });

        if (Number.isFinite(scrollResult.x) && Number.isFinite(scrollResult.y)) {
          await this.page.mouse.move(scrollResult.x, scrollResult.y);
          try { await this.page.mouse.wheel({ deltaY: 1800 }); } catch (e) { }
        }

        await delay(500);

        const reachedEnd = scrollResult.moved && scrollResult.after >= scrollResult.max - 5;
        const visibleStuck = scrollResult.visibleIds === previousVisibleKey;
        const sizeStuck = recipients.size === prevSize;
        const grew = recipients.size > prevSize;

        if (grew) {
          stable = 0;
        } else if ((sizeStuck && visibleStuck) || reachedEnd) {
          stable++;
        } else {
          stable = 0;
        }

        if (stable >= 5) {
          if (targetCount && recipients.size < targetCount) {
            console.warn(`Friend list stopped at ${recipients.size}/${targetCount}`);
          }
          break;
        }
        prevSize = recipients.size;
        previousVisibleKey = scrollResult.visibleIds;
      }

      console.log("Finished loading all friends");

      this.lastRecipientList = Array.from(recipients.values());
      const data = this.lastRecipientList.map(({ id, name }) => ({ id, name }));

      if (!data.length) {
        throw new SnapchatSDKError(ErrorCodes.FRIEND_LIST_EMPTY, "No friends found in list");
      }

      return targetCount ? data.slice(0, targetCount) : data;
    } catch (error) {
      if (error instanceof SnapchatSDKError) throw error;
      if (ac.signal.aborted) {
        throw new SnapchatSDKError(
          ErrorCodes.FRIEND_LIST_TIMEOUT,
          `Friend list loading timed out after ${timeoutMs}ms`,
          { cause: error }
        );
      }
      throw wrapError(ErrorCodes.OPERATION_FAILED, "Failed to load friend list", error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendMessage(obj) {
    await this.waitForState("app_ready");
    const startTime = Date.now();
    const userId = obj.chat;

    // Open chat if not already open (handles scroll-to-user via cached position)
    if (!obj.alreadyOpen) {
      await this.openChat(userId);
    }

    // Wait for the chat input box
    await this.page.waitForSelector('div[role="textbox"]', {
      visible: true,
      timeout: 15000
    });

    if (this.state !== "app_ready") {
      throw new Error("Page navigated away during sendMessage");
    }

    const input = await this.page.$('div[role="textbox"]');
    if (!input) {
      throw new Error("Message input not found");
    }

    await input.focus();

    const rawMessages = Array.isArray(obj.message) ? obj.message : [obj.message];
    const messages = rawMessages.filter(m => String(m).trim().length > 0);
    let sentCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msgStr = String(messages[i]);
      const msgKey = `${userId}:${msgStr}`;
      const lastSent = this._lastSentMap.get(msgKey);
      if (lastSent && Date.now() - lastSent < 15000) {
        console.warn(`  skipping duplicate message ${i + 1}/${messages.length} (sent ${Math.round((Date.now() - lastSent) / 1000)}s ago)`);
        skippedCount++;
        continue;
      }
      const msg = String(messages[i]);

      if (this.state !== "app_ready") {
        throw new Error(`Page navigated away at message ${i + 1}/${messages.length}`);
      }

      // Multi-line: use Shift+Enter for line breaks, then Enter to send
      const lines = msg.split("\n");
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line.length > 200) {
          // Long text: paste via clipboard to avoid keystroke fragility
          await this.page.evaluate((text) => {
            const el = document.querySelector('div[role="textbox"]');
            if (!el) return;
            el.focus();
            document.execCommand("insertText", false, text);
          }, line);
        } else {
          await this.page.keyboard.type(line);
        }
        if (li < lines.length - 1) {
          await this.page.keyboard.down("Shift");
          await this.page.keyboard.press("Enter");
          await this.page.keyboard.up("Shift");
          await delay(200);
        }
      }

      await this.page.keyboard.press("Enter");
      sentCount++;

      // Post-send verification: wait for message to appear in DOM
      try {
        const escaped = msg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 50);
        await this.page.waitForFunction(
          (uid, text) => {
            const container = document.querySelector(`#cv-${CSS.escape(uid)}`);
            if (!container) return false;
            return Array.from(container.querySelectorAll("div.KB4Aq.SOEIP.IPEgq"))
              .some(el => el.textContent.includes(text));
          },
          { timeout: 5000 },
          userId, escaped
        );
        this._lastSentMap.set(msgKey, Date.now());
      } catch {
        console.warn(`sendMessage: message ${i + 1}/${messages.length} not confirmed in DOM`);
        this._lastSentMap.set(msgKey, Date.now());
      }

      if (messages.length > 1 && i < messages.length - 1) {
        console.log(`  sent ${i + 1}/${messages.length}`);
        await delay(600);
      }
    }

    const elapsed = Date.now() - startTime;
    const skipMsg = skippedCount > 0 ? ` (${skippedCount} skipped as duplicates)` : "";
    console.log(`✅ ${sentCount} message(s) sent in ${elapsed}ms${skipMsg}`);
  }

  async saveCookies(username) {
    try {
      const cookies = await this.browser.cookies();
      fs.writeFileSync(
        `./${username}-cookies.json`,
        JSON.stringify(cookies, null, 2)
      );
      console.log("cookies saved for : ", username);
    } catch (error) {
      console.error("Error in saving cookies", error);
    }
  }

  async useCookies(username) {
    try {
      const cookiesString = fs.readFileSync(`./${username}-cookies.json`);
      const cookies = JSON.parse(cookiesString);
      await this.browser.setCookie(...cookies);
    } catch (error) {
      console.error("Error in using cookies", error);
    }
  }
  async openChat(userId) {
    await this.waitForState("app_ready");
    await this.page.waitForSelector("div[role='listitem']");

    const clickVisibleChat = async () => {
      try {
        return await this.page.evaluate((targetId) => {
          const title = document.querySelector(`#title-${CSS.escape(targetId)}`);
          if (!title) return false;

          try {
            title.scrollIntoView({ block: "nearest" });
            const rect = title.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              title.scrollIntoView({ block: "center" });
            }
          } catch (e) {
            title.scrollIntoView({ block: "center" });
          }
          title.click();
          return true;
        }, userId);
      } catch (e) {
        console.log("clickVisibleChat error:", e.message?.slice(0, 150));
        return false;
      }
    };

    if (await clickVisibleChat()) {
      await this.page.waitForSelector(
        'div[role="textbox"], div[contenteditable="true"]',
        { visible: true, timeout: 20000 }
      );
      console.log("✅ Chat opened:", userId);
      return;
    }

    if (!this.recipientScrollCache.size) {
      console.log(`recipientScrollCache empty (getFriends() may not have been called), falling back to full list scan for ${userId}`);
    }

    const cachedUser = this.recipientScrollCache.get(userId);

    if (cachedUser && typeof cachedUser.index === "number") {
      console.log(`Jumping to cached chat position: ${cachedUser.name} (index ${cachedUser.index})`);
      await this.page.evaluate((index) => {
        const findScrollable = () => {
          const title = document.querySelector("div[role='listitem'] span[id^='title-']");
          let node = title?.parentElement;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 10) return node;
            node = node.parentElement;
          }
          const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
          return candidates.find(el =>
            el.scrollHeight > el.clientHeight + 10 &&
            el.querySelector("div[role='listitem'] span[id^='title-']")
          ) || document.scrollingElement;
        };

        const container = findScrollable();
        if (!container) return;

        const firstItem = document.querySelector("div[role='listitem']");
        const itemHeight = firstItem ? firstItem.getBoundingClientRect().height : 72;
        container.scrollTo(0, Math.max(0, index * itemHeight - 100));
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
      }, cachedUser.index);

      await delay(500);

      if (await clickVisibleChat()) {
        await this.page.waitForSelector(
          'div[role="textbox"], div[contenteditable="true"]',
          { visible: true, timeout: 20000 }
        );
        console.log("✅ Chat opened:", userId);
        return;
      }
    }

    await this.page.evaluate(() => {
      const findScrollable = () => {
        const candidates = [
          document.querySelector(".ReactVirtualized__Grid"),
          document.querySelector("[role='grid']"),
          document.querySelector(".ReactVirtualized__Grid__innerScrollContainer")?.parentElement,
          document.scrollingElement,
        ].filter(Boolean);

        return candidates.find(el => el.scrollHeight > el.clientHeight + 10);
      };

      const container = findScrollable();
      if (!container) return;
      container.scrollTo(0, 0);
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await delay(500);

    let stable = 0;

    while (true) {
      const found = await clickVisibleChat();

      if (found) break;

      const scrollResult = await this.page.evaluate(() => {
        const findScrollable = () => {
          const title = document.querySelector("div[role='listitem'] span[id^='title-']");
          let node = title?.parentElement;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 10) return node;
            node = node.parentElement;
          }
          const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
          return candidates.find(el =>
            el.scrollHeight > el.clientHeight + 10 &&
            el.querySelector("div[role='listitem'] span[id^='title-']")
          ) || document.scrollingElement;
        };

        const container = findScrollable();
        if (!container) return { moved: false, atEnd: true };

        const before = container.scrollTop;
        const amount = Math.max(900, Math.floor(container.clientHeight * 1.5));
        container.scrollBy(0, amount);
        container.dispatchEvent(new Event("scroll", { bubbles: true }));

        const after = container.scrollTop;
        const max = container.scrollHeight - container.clientHeight;
        return { moved: after !== before, after, max, atEnd: after >= max - 5 };
      });

      await delay(800);

      if (!scrollResult.moved || scrollResult.atEnd) {
        stable++;
      } else {
        stable = 0;
      }

      if (stable >= 5) {
        throw new Error("Chat not found: " + userId);
      }
    }

    // ✅ stable wait
    await this.page.waitForSelector(
      'div[role="textbox"], div[contenteditable="true"]',
      { visible: true, timeout: 20000 }
    );

    console.log("✅ Chat opened:", userId);
  }
  async #waitForChatStability(userId) {
    await this.page.evaluate(async (uid) => {
      const container = document.querySelector(`#cv-${CSS.escape(uid)}`);
      if (!container) return;

      const sDelay = (ms) => new Promise(r => setTimeout(r, ms));
      let prevCount = container.querySelectorAll("li.T1yt2").length;
      let stableCount = 0;

      for (let i = 0; i < 10; i++) {
        await sDelay(500);
        const currentCount = container.querySelectorAll("li.T1yt2").length;
        if (currentCount === prevCount) {
          stableCount++;
          if (stableCount >= 4) break;
        } else {
          stableCount = 0;
          prevCount = currentCount;
        }
      }
    }, userId);
  }

  async #scrollAndExtract(userId, { timeout = 30000, signal, maxMessages } = {}) {
    const startTime = Date.now();

    const msgCount = await this.page.evaluate(async ({ uid, ttl, maxMsgs }) => {
      const container = document.querySelector(`#cv-${CSS.escape(uid)}`);
      if (!container) return -1;

      const countMsgs = () => {
        let c = 0;
        const blocks = container.querySelectorAll("li.T1yt2");
        for (const b of blocks) c += b.querySelectorAll("ul.ujRzj > li").length;
        if (c === 0) c = container.querySelectorAll("li.T1yt2 > ul > li, li > div.KB4Aq, li > div[id]").length;
        return c;
      };

      let scrollable = container.parentElement;
      while (scrollable && scrollable !== document.body) {
        const cs = window.getComputedStyle(scrollable);
        if (scrollable.scrollHeight > scrollable.clientHeight + 10 &&
            (cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflow === "auto")) break;
        scrollable = scrollable.parentElement;
      }
      if (!scrollable || scrollable === document.body) {
        scrollable = container.closest('[style*="overflow"]') || container.parentElement;
      }

      const sDelay = (ms) => new Promise(r => setTimeout(r, ms));
      const timeLimit = Date.now() + ttl;

      scrollable.scrollTop = 0;
      scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sDelay(1000);

      let prevCount = countMsgs();
      let stable = 0;
      let step = 0;

      while (step < 30) {
        if (Date.now() > timeLimit) break;
        step++;

        scrollable.scrollTop += scrollable.clientHeight * 1.5;
        scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sDelay(800);

        const currentCount = countMsgs();
        if (currentCount > prevCount) {
          if (step === 1 || step % 5 === 0) {
            console.log(`scroll step ${step}: ${prevCount} → ${currentCount} msgs`);
          }
          stable = 0;
          prevCount = currentCount;
        } else {
          stable++;
        }
        if (stable >= 5) {
          if (step > 1) console.log(`scroll stable at step ${step}, ${prevCount} msgs`);
          break;
        }

        if (maxMsgs && currentCount >= maxMsgs) {
          console.log(`scroll reached max ${maxMsgs} msgs at step ${step}`);
          break;
        }
      }

      scrollable.scrollTop = scrollable.scrollHeight;
      scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sDelay(1000);

      return countMsgs();
    }, { uid: userId, ttl: timeout, maxMsgs: maxMessages });

    if (signal?.aborted) throw new Error("extractChatData aborted");

    const elapsed = Date.now() - startTime;
    console.log(`scroll done: ${msgCount >= 0 ? msgCount : "?"} msgs in ${elapsed}ms`);

    return await this.page.evaluate(extractFromDOM, userId);
  }

  async extractChatData(userId, options = {}) {
    const { timeout = 30000, signal, maxMessages } = options;
    const startTime = Date.now();

    const attemptExtract = async () => {
      await this.page.waitForFunction(
        (uid) => !!document.querySelector(`#cv-${CSS.escape(uid)}`),
        { timeout: 8000 },
        userId
      );

      await this.#waitForChatStability(userId);

      if (signal?.aborted) throw new Error("extractChatData aborted");

      const result = await this.#scrollAndExtract(userId, { timeout, signal, maxMessages });

      return result;
    };

    try {
      const result = await attemptExtract();
      if (!result) throw new Error("Chat container not ready");
      const elapsed = Date.now() - startTime;
      const totalMsgs = result.chat.reduce((s, b) => s + (b.conversation?.length || 0), 0);
      console.log(`extractChatData done: ${result.chat.length} blocks, ${totalMsgs} msgs in ${elapsed}ms`);
      return result;

    } catch (err) {
      if (signal?.aborted) throw new Error("extractChatData aborted");
      console.log("extractChatData failed, retrying...", err.message);

      await delay(2000);
      if (signal?.aborted) throw new Error("extractChatData aborted");
      const quickRetry = await this.page.evaluate(extractFromDOM, userId);
      if (quickRetry) {
        const elapsed = Date.now() - startTime;
        console.log(`extractChatData quickRetry done: ${quickRetry.chat.length} blocks in ${elapsed}ms`);
        return quickRetry;
      }

      if (signal?.aborted) throw new Error("extractChatData aborted");
      await this.page.reload({ waitUntil: "networkidle2" });
      await delay(2000);
      if (signal?.aborted) throw new Error("extractChatData aborted");
      await this.handlePopup();
      if (signal?.aborted) throw new Error("extractChatData aborted");
      await this.openChat(userId);
      await delay(1500);

      if (signal?.aborted) throw new Error("extractChatData aborted");

      const retryResult = await this.page.evaluate(extractFromDOM, userId);
      return retryResult ?? { id: userId, name: "Unknown", chat: [] };
    }
  }

  async userStatus(limit = null) {
    await this.waitForState("app_ready");
    const targetCount = Number.isInteger(limit) && limit > 0 ? limit : null;
    console.log("Waiting for friend list (dynamic)...");

    await this.page.waitForSelector(
      "div.ReactVirtualized__Grid__innerScrollContainer",
      { timeout: 60000 }
    );

    await this.page.waitForFunction(() => {
      return document.querySelectorAll("div[role='listitem'] span[id^='title-']").length > 0;
    }, { timeout: 60000 });

    await this.page.evaluate(() => {
      const findScrollable = () => {
        const title = document.querySelector("div[role='listitem'] span[id^='title-']");
        let node = title?.parentElement;

        while (node && node !== document.body) {
          if (node.scrollHeight > node.clientHeight + 10) return node;
          node = node.parentElement;
        }

        const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
        return candidates.find(el =>
          el.scrollHeight > el.clientHeight + 10 &&
          el.querySelector("div[role='listitem'] span[id^='title-']")
        ) || document.scrollingElement;
      };

      const container = findScrollable();
      if (!container) return;
      container.scrollTo(0, 0);
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await delay(500);

    const statuses = new Map();
    let prevSize = 0;
    let stallCount = 0;
    let previousScrollTop = -1;

    while (true) {
      const snapshot = await this.page.evaluate(() => {
        const findScrollable = () => {
          const title = document.querySelector("div[role='listitem'] span[id^='title-']");
          let node = title?.parentElement;

          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 10) return node;
            node = node.parentElement;
          }

          const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
          return candidates.find(el =>
            el.scrollHeight > el.clientHeight + 10 &&
            el.querySelector("div[role='listitem'] span[id^='title-']")
          ) || document.scrollingElement;
        };

        const container = findScrollable();
        const scrollTop = container?.scrollTop ?? 0;

        const users = Array.from(document.querySelectorAll("div[role='listitem'] span[id^='title-']"))
          .map(titleSpan => {
            const id = titleSpan.id.replace(/^title-/, "");
            const name = titleSpan.textContent.trim();
            const listItem = titleSpan.closest("div[role='listitem']");
            const statusContainer = listItem?.querySelector(`#status-${CSS.escape(id)}`);
            const statusParent = statusContainer?.parentElement;
            let statusTexts = statusParent
              ? Array.from(statusParent.querySelectorAll("span")).map(span => span.textContent.trim())
              : [];

            if (!statusTexts.length && listItem) {
              const allSpans = Array.from(listItem.querySelectorAll("span"));
              const titleSpan = listItem.querySelector(`span[id^='title-']`);
              statusTexts = allSpans
                .filter(s => s !== titleSpan && s.textContent.trim())
                .map(s => s.textContent.trim());
            }

            const cleanedStatus = statusTexts
              .map(t => t?.trim())
              .filter(t =>
                t &&
                t !== "·" &&
                t.length < 60 &&
                !t.includes("\n")
              );

            const STATUS_PATTERNS = [
              { type: "say_hi",   match: /^say\s?hi!?$/i },
              { type: "say_hi",   match: /^you are now friends$/i },
              { type: "new_chat", match: /^new chat$/i },
              { type: "new_chat", match: /group (chat|mention)/i },
              { type: "new_chat", match: /topic chat/i },
              { type: "new_snap", match: /^\d+\s*new\s+snaps?$/i },
              { type: "new_snap", match: /^new\s+(chats?\s+and\s+)?snaps?/i },
              { type: "new_snap", match: /double-tap to (replay|snap)/i },
              { type: "new_snap", match: /reacted to your snap/i },
              { type: "opened",   match: /^opened$/i },
              { type: "received", match: /^received$/i },
              { type: "delivered",match: /^delivered$/i },
            ];

            let matchedType = null;
            let matchedText = null;
            for (const span of cleanedStatus) {
              for (const { type, match } of STATUS_PATTERNS) {
                if (match.test(span)) {
                  matchedType = type;
                  matchedText = span;
                  break;
                }
              }
              if (matchedType) break;
            }

            if (!matchedType && cleanedStatus.length > 0) {
              matchedType = "unknown";
              matchedText = cleanedStatus[0];
            }

            const streakStr = statusTexts.find(t => t.includes("🔥")) || null;

            return {
              id,
              name,
              status: {
                type: matchedType,
                text: matchedText,
                time: cleanedStatus.find(t => /\d+\s?[mhdw]/i.test(t) || /^[a-z]{3}\s+\d{1,2}$/i.test(t) || /^yesterday$/i.test(t)) || null,
                streak: streakStr,
              }
            };
          })
          .filter(user => user.name && user.name.toLowerCase() !== "my ai");

        return { users, scrollTop };
      });

      for (const user of snapshot.users) {
        if (!statuses.has(user.id)) {
          statuses.set(user.id, user);
          this.recipientScrollCache.set(user.id, {
            id: user.id,
            name: user.name,
            index: this.recipientScrollCache.size,
            scrollTop: snapshot.scrollTop
          });
        }
      }

      console.log("Current status loaded:", statuses.size);

      if (targetCount && statuses.size >= targetCount) break;

      const scrollResult = await this.page.evaluate(() => {
        const findScrollable = () => {
          const title = document.querySelector("div[role='listitem'] span[id^='title-']");
          let node = title?.parentElement;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 10) return node;
            node = node.parentElement;
          }
          const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll']"));
          if (candidates.length) {
            const found = candidates.find(el =>
              el.scrollHeight > el.clientHeight + 10 &&
              el.querySelector("div[role='listitem'] span[id^='title-']")
            );
            if (found) return found;
          }
          const fallback = document.querySelector(".ReactVirtualized__Grid__innerScrollContainer");
          if (fallback && fallback.scrollHeight > fallback.clientHeight + 10) return fallback;
          return document.scrollingElement;
        };

        const container = findScrollable();
        if (!container) return { moved: false };

        const before = container.scrollTop;
        const amount = Math.max(900, Math.floor(container.clientHeight * 1.5));
        container.scrollBy(0, amount);
        container.dispatchEvent(new Event("scroll", { bubbles: true }));

        return { moved: container.scrollTop !== before, before, after: container.scrollTop };
      });

      await delay(800);

      if (statuses.size > prevSize) {
        stallCount = 0;
        prevSize = statuses.size;
        continue;
      }

      if (scrollResult.moved) {
        stallCount = 0;
        prevSize = statuses.size;
        continue;
      }

      stallCount++;
      if (stallCount >= 5) {
        if (targetCount && statuses.size < targetCount) {
          console.warn(`Friend status list stopped at ${statuses.size}/${targetCount}`);
        }
        break;
      }
      await delay(500);
    }

    const data = Array.from(statuses.values());
    return targetCount ? data.slice(0, targetCount) : data;
  }

  async blockTypingNotifications(shouldBlock) {
    await this.waitForState("app_ready");
    const client = await this.page.createCDPSession();

    await client.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: "*SendTypingNotification*",
          requestStage: "Request",
        },
      ],
    });

    client.on("Fetch.requestPaused", async (event) => {
      const url = event.request.url;

      if (
        shouldBlock &&
        url.includes(
          "https://web.snapchat.com/messagingcoreservice.MessagingCoreService/SendTypingNotification"
        )
      ) {
        // console.log("[CDPBlock] Aborting request:", url);
        await client.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Failed",
        });
      } else {
        await client.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
      }
    });
  }

  async useShortcut(shortcutsArray) {
    await this.waitForState("app_ready");

    const sendPanelClicked = await this.page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const selectors = [
        'button[aria-label*="Send" i]',
        'button[title*="Send" i]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && visible(btn)) { btn.click(); return true; }
      }
      const btn = Array.from(document.querySelectorAll("button"))
        .find(b => visible(b) && /send|next/i.test(`${b.textContent} ${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`));
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!sendPanelClicked) {
      console.warn("Send button not found for shortcuts");
      return;
    }
    console.log("Send button clicked for shortcuts");

    await delay(2000);

    for (const emoji of shortcutsArray) {
      const clicked = await this.page.evaluate((targetEmoji) => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const btn = Array.from(document.querySelectorAll("button"))
          .find(b => visible(b) && b.textContent.trim() === targetEmoji);
        if (!btn) return false;
        btn.click();
        return true;
      }, emoji);

      if (clicked) {
        await this.page.evaluate(() => {
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const selectors = [
            'button[aria-label*="Select" i]',
            'button[title*="Select" i]',
          ];
          for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && visible(btn)) { btn.click(); return true; }
          }
          const btn = Array.from(document.querySelectorAll("button"))
            .find(b => visible(b) && /select|ok|confirm|done/i.test(b.textContent.trim()));
          if (btn) { btn.click(); return true; }
          return false;
        });

        await delay(300);
        await this.page.evaluate((targetEmoji) => {
          const btn = Array.from(document.querySelectorAll("button"))
            .find(b => {
              const rect = b.getBoundingClientRect();
              const style = window.getComputedStyle(b);
              const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
              return visible && b.textContent.trim() === targetEmoji;
            });
          if (btn) { btn.click(); return true; }
          return false;
        }, emoji);
      }

      if (!clicked) {
        console.warn(`Shortcut "${emoji}" not found.`);
      }
    }

    const sendButton = await this.page.$("button[type='submit']");
    if (sendButton) {
      await sendButton.click();
    } else {
      await this.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button"))
          .find(b => {
            const rect = b.getBoundingClientRect();
            const style = window.getComputedStyle(b);
            const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            return visible && (b.type === "submit" || /^send$/i.test(b.textContent.trim()));
          });
        if (btn) btn.click();
      });
    }
  }

  // add custom methods
  static extend(methods) {
    Object.assign(PrivateSnapchatEngine.prototype, methods);
  }
}
