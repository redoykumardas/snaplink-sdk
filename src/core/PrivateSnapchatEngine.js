import puppeteer from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";

puppeteer.use(Stealth());

import fs from "fs";
import fsPromise from "fs/promises";

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
      console.log(`SnapchatEngine state: ${this.state} -> ${state}`);
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

  async waitForState(states) {
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
        "button.qJKfS",
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
      throw new Error("Credentials cannot be empty");
    }

    try {
      console.log("Waiting for username form...");
      await this.waitForState("login_ready");

      // Scan for ANY input field dynamically (broader than type="text")
      await this.page.waitForFunction(
        () => {
          const inputs = document.querySelectorAll('input');
          for (const input of inputs) {
            const type = input.type?.toLowerCase();
            // Accept text, email, tel, or inputs with no type
            if (type === 'text' || type === 'email' || type === 'tel' || !type) {
              // Must be visible
              const rect = input.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true;
              }
            }
          }
          return false;
        },
        { timeout: 0 }
      );

      // Find the actual input element
      const usernameInput = await this.page.evaluateHandle(() => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          const type = input.type?.toLowerCase();
          if (type === 'text' || type === 'email' || type === 'tel' || !type) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return input;
            }
          }
        }
        return null;
      });

      if (!usernameInput) {
        await this.page.screenshot({ path: "debug-login-fail.png" });
        throw new Error("Username input not found");
      }

      console.log("Entering username...");
      await usernameInput.type(username, { delay: 100 });

      await this.page.keyboard.press("Enter");
      this.setState("authenticating");

      console.log("Navigated to password page, URL:", this.page.url());

    } catch (e) {
      console.log("Username field error:", e.message);
      throw e;
    }

    // --- Password page ---
    try {
      console.log("Waiting for password field...");
      await this.page.waitForSelector("#password", { visible: true, timeout: 0 });
      await this.page.type("#password", password, { delay: 100 });
      console.log("Password field filled.");

      await this.page.keyboard.press("Enter");
      this.setState("authenticating");

      await this.waitForState("app_ready");
      console.log("Login complete, URL:", this.page.url());

    } catch (e) {
      console.log("Password field loading error:", e.message);
      throw e;
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
        await this.page.waitForSelector('div[role="listitem"], button.qJKfS', { timeout: 15000 });
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

  async waitForSnapPreview(timeout = 15000) {
    await this.page.waitForSelector('#snap-preview-container', { timeout, visible: true });
    console.log("Preview screen detected");
    await delay(1000);
    await this.screenshot({ path: "debug-preview-ready.png" });
  }

  async tryUploadSnapImage(imagePath) {
    const existingInput = await this.page.$('input[type="file"]');
    if (existingInput) {
      try {
        await existingInput.uploadFile(imagePath);
        await this.waitForSnapPreview(15000);
        console.log("Image uploaded through file input");
        return true;
      } catch (error) {
        console.warn("File input upload did not reach preview:", error.message);
      }
    }

    const chooserPromise = this.page.waitForFileChooser({ timeout: 3000 }).catch(() => null);
    const clickedUpload = await this.page.evaluate(() => {
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

    if (!clickedUpload) return false;

    try {
      const chooser = await chooserPromise;
      if (!chooser) return false;

      await chooser.accept([imagePath]);
      await this.waitForSnapPreview(15000);
      console.log("Image uploaded through upload chooser");
      return true;
    } catch (error) {
      console.warn("Upload chooser did not reach preview:", error.message);
      return false;
    }
  }

  async replacePreviewImage(imagePath) {
    try {
      const imageBase64 = await fsPromise.readFile(imagePath, "base64");
      const imageData = `data:image/png;base64,${imageBase64}`;
      const replaced = await this.page.evaluate((imgData) => {
        const previewImg = document.querySelector('#snap-preview-container img.VcjuA, #snap-preview-container img');
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

  async addSnapCaption(caption) {
    if (!caption) return;

    const captionBtnClicked = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const title = btn.getAttribute('title') || '';
        const label = btn.getAttribute('aria-label') || '';
        if (`${title} ${label}`.toLowerCase().includes('caption')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!captionBtnClicked) {
      console.warn("Could not find 'Add a caption' button");
      return;
    }

    console.log("Clicked 'Add a caption' - waiting for input");
    await delay(1500);

    let captionInput = await this.page.$('textarea[aria-label*="Caption input" i], textarea[aria-label*="Caption" i]');
    if (!captionInput) {
      captionInput = await this.page.$('div[contenteditable="true"]');
    }

    if (captionInput) {
      await captionInput.click();
      await captionInput.type(caption, { delay: 100 });
      console.log("Caption typed");
    } else {
      console.warn("Caption input field not found");
      await this.screenshot({ path: "debug-caption-input-missing.png" });
    }
  }

  async captureSnap(obj) {
    await this.waitForState("app_ready");
    try {
      console.log("Attempting to open camera...");
      const cameraOpened = await this.page.evaluate(() => {
        const selectors = [
          'button[aria-label="Camera"]',
          'button[data-testid="cameraButton"]',
          'button[aria-label="Take a Snap"]',
          'button.qJKfS',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.getBoundingClientRect().width > 0) {
            btn.click();
            return true;
          }
        }
        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
          const svg = btn.querySelector('svg');
          if (svg && (svg.innerHTML.includes('M35 45.118') || svg.innerHTML.includes('camera'))) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (!cameraOpened) throw new Error("Could not open camera");
      console.log("Camera button clicked – waiting for camera UI");

      await delay(1000);

      if (obj.path && await this.tryUploadSnapImage(obj.path)) {
        await this.addSnapCaption(obj.caption);
        console.log("Snap ready on preview screen");
        return;
      }

      try {
        await this.page.waitForFunction(
          () => {
            const video = document.querySelector('video#local-video, video');
            return video && video.readyState >= 2 && video.videoWidth > 0;
          },
          { timeout: obj.path ? 5000 : 15000 }
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
          'button.FBYjn.gK0xL.A7Cr_.m3ODJ',
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

      await this.addSnapCaption(obj.caption);
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
      let selected = "";
      person = person.toLowerCase();
      if (person == "bestfriends") {
        selected = "ul.UxcmY li  div.Ewflr.cDeBk.A8BRr ";
      } else if (person == "groups") {
        selected = "li div.RbA83";
      } else if (person == "friends") {
        selected = "li div.Ewflr";
      } else if (person == "all") {
        console.log("not implemented yet");
      } else {
        throw new Error("Option not found");
      }
      const accounts = await this.page.$$(selected);
      if (!accounts.length) {
        throw new Error(`No snap recipients found for ${person}`);
      }

      for (const account of accounts) {
        const isFriendVisible = await account.evaluate(
          (el) => el.offsetWidth > 0 && el.offsetHeight > 0
        ); // Check if the div is visible
        if (isFriendVisible) {
          await account.click(); // Click on the div element
        } else {
          console.log("account not found.");
        }
      }
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
        "button.YatIx.fGS78.eKaL7.Bnaur",
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

    await delay(1000);
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

    await delay(5000);
  }

  async sendToFriends(recipients) {
    await this.waitForState("app_ready");
    const targets = recipients
      .map((recipient) => {
        if (typeof recipient === "string") return { id: recipient, name: recipient };
        return {
          id: recipient?.id ?? recipient?.userId ?? recipient?.username ?? recipient?.name,
          name: recipient?.name ?? recipient?.displayName ?? recipient?.username ?? recipient?.id,
        };
      })
      .filter(target => target.id || target.name);

    if (!targets.length) {
      throw new Error("sendToFriends requires at least one friend id or name");
    }

    await this.openSnapSendPanel();

    const selected = new Set();
    let stable = 0;
    let previousVisibleKey = "";

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
          return { id, name, text: row.textContent || "" };
        };

        const matches = (row, target) => {
          const data = getRowData(row);
          const id = normalize(data.id);
          const name = normalize(data.name);
          const text = normalize(data.text);
          const targetId = normalize(target.id);
          const targetName = normalize(target.name);

          return Boolean(
            (targetId && id && id === targetId) ||
            (targetId && text.includes(targetId)) ||
            (targetName && name && name === targetName) ||
            (targetName && text.includes(targetName))
          );
        };

        const findScrollable = () => {
          const candidates = Array.from(document.querySelectorAll(".ReactVirtualized__Grid, [role='grid'], [class*='scroll'], ul, div"))
            .filter(el => el.scrollHeight > el.clientHeight + 10);
          return candidates.find(el => /send|friend|best|group/i.test(el.textContent || ""))
            || candidates[0]
            || document.scrollingElement;
        };

        const rows = Array.from(document.querySelectorAll("li, [role='listitem'], [role='option']"))
          .filter(visible);
        const clicked = [];

        for (const target of targetList) {
          const key = target.id || target.name;
          if (selectedKeys.includes(key)) continue;

          const row = rows.find(item => matches(item, target));
          if (!row) continue;

          const clickTarget = row.querySelector('[role="checkbox"], button, div.Ewflr, div.RbA83, label') || row;
          clickTarget.click();
          clicked.push(key);
        }

        const visibleKey = rows.map(row => row.textContent.trim()).join("|").slice(0, 5000);
        const container = findScrollable();
        if (!container) return { clicked, moved: false, visibleKey };

        const before = container.scrollTop;
        const amount = Math.max(700, Math.floor(container.clientHeight * 1.2));
        container.scrollBy(0, amount);
        container.dispatchEvent(new Event("scroll", { bubbles: true }));

        const rect = container.getBoundingClientRect();
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
      }

      if (Number.isFinite(result.x) && Number.isFinite(result.y)) {
        await this.page.mouse.move(result.x, result.y);
        await this.page.mouse.wheel({ deltaY: 1200 });
      }

      if (result.clicked.length || (result.moved && result.visibleKey !== previousVisibleKey)) {
        stable = 0;
      } else {
        stable++;
      }

      if (stable >= 10) break;

      previousVisibleKey = result.visibleKey;
      await delay(400);
    }

    if (selected.size < targets.length) {
      const missing = targets
        .filter(target => !selected.has(target.id || target.name))
        .map(target => target.name || target.id);
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

    await delay(5000);
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

  async listRecipients(limit = null) {
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

    const recipients = new Map();
    this.recipientScrollCache.clear();
    this.lastRecipientList = [];
    let prevSize = 0;
    let stable = 0;
    let previousVisibleKey = "";

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
        await this.page.mouse.wheel({ deltaY: 1800 });
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

      if (stable >= 8) {
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
    return targetCount ? data.slice(0, targetCount) : data;
  }

  async sendMessage(obj) {
    await this.waitForState("app_ready");
    await this.page.waitForSelector(
      "div.ReactVirtualized__Grid__innerScrollContainer"
    );

    const lists = await this.page.$$("div[role='listitem']");
    let found = false;

    for (const listItem of lists) {
      const titleSpan = await listItem.$("span[id^='title-']");
      if (!titleSpan) continue;

      const id = await this.page.evaluate((el) => el.id, titleSpan);
      const chatID = "title-" + obj.chat;

      if (id === chatID) {
        found = true;
        console.log("User matched:", obj.chat);

        if (!obj.alreadyOpen) {
          await titleSpan.click();
        }

        // wait for chat box (stable)
        await this.page.waitForSelector('div[role="textbox"]', {
          visible: true,
          timeout: 15000
        });

        const input = await this.page.$('div[role="textbox"]');

        if (!input) {
          throw new Error("Message input not found");
        }

        await input.focus();

        if (Array.isArray(obj.message)) {
          for (let msg of obj.message) {
            await this.page.keyboard.type(msg);
            await this.page.keyboard.press("Enter");
          }
        }

        if (typeof obj.message === "string" && obj.message !== "") {
          await this.page.keyboard.type(obj.message);
          await this.page.keyboard.press("Enter");
        }

        console.log("✅ Message sent");

        if (obj.exit) {
          await titleSpan.click();
        }

        break;
      }
    }

    if (!found) {
      throw new Error(`User not found: ${obj.chat}`);
    }
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
      return await this.page.evaluate((targetId) => {
        const title = document.querySelector(`#title-${CSS.escape(targetId)}`);
        if (!title) return false;

        title.scrollIntoView({ block: "center" });
        title.click();
        return true;
      }, userId);
    };

    if (await clickVisibleChat()) {
      await this.page.waitForSelector(
        'div[role="textbox"], div[contenteditable="true"]',
        { visible: true, timeout: 20000 }
      );
      console.log("✅ Chat opened:", userId);
      return;
    }

    const cachedUser = this.recipientScrollCache.get(userId);

    if (cachedUser) {
      console.log(`Jumping to cached chat position: ${cachedUser.name}`);
      await this.page.evaluate((scrollTop) => {
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

        container.scrollTo(0, Math.max(0, scrollTop - 80));
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
      }, cachedUser.scrollTop);

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
    let previousVisibleKey = "";

    while (true) {
      const found = await clickVisibleChat();

      if (found) break;

      const scrollResult = await this.page.evaluate(() => {
        const findScrollable = () => {
          const candidates = [
            document.querySelector(".ReactVirtualized__Grid"),
            document.querySelector("[role='grid']"),
            document.querySelector(".ReactVirtualized__Grid__innerScrollContainer")?.parentElement,
            document.scrollingElement,
          ].filter(Boolean);

          return candidates.find(el => el.scrollHeight > el.clientHeight + 10);
        };

        const visibleIds = Array.from(
          document.querySelectorAll("div[role='listitem'] span[id^='title-']")
        ).map(el => el.id).join("|");

        const container = findScrollable();
        if (!container) return { moved: false, visibleIds };

        const before = container.scrollTop;
        const amount = Math.max(700, Math.floor(container.clientHeight * 0.9));
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

      if (!scrollResult.moved && Number.isFinite(scrollResult.x) && Number.isFinite(scrollResult.y)) {
        await this.page.mouse.move(scrollResult.x, scrollResult.y);
        await this.page.mouse.wheel({ deltaY: 1200 });
      }

      await delay(350);

      const reachedEnd = scrollResult.moved && scrollResult.after >= scrollResult.max - 5;
      if (scrollResult.visibleIds === previousVisibleKey || reachedEnd) {
        stable++;
      } else {
        stable = 0;
      }

      if (stable >= 4) {
        throw new Error("Chat not found: " + userId);
      }

      previousVisibleKey = scrollResult.visibleIds;
    }

    // ✅ stable wait
    await this.page.waitForSelector(
      'div[role="textbox"], div[contenteditable="true"]',
      { visible: true, timeout: 20000 }
    );

    console.log("✅ Chat opened:", userId);
  }
  async extractChatData(userId) {
    // Shared DOM extractor — returns { name, chat } or null if not ready
    const extractFromDOM = (userId) => {
      const container = document.querySelector(`#cv-${userId}`);
      if (!container) return null;

      const items = container.querySelectorAll("li.T1yt2");
      if (!items.length) return null;

      // Grab the friend's display name from the sidebar
      const nameEl = document.querySelector(`#title-${userId}`);
      const name = nameEl ? nameEl.textContent.trim() : "Unknown";

      const chat = [];
      let currentBlock = null;

      items.forEach((item) => {
        // Date separator row
        const timeEl = item.querySelector("time span");
        if (timeEl) {
          if (currentBlock) chat.push(currentBlock);
          currentBlock = { time: timeEl.textContent.trim(), conversation: [] };
          return;
        }

        if (!currentBlock) {
          currentBlock = { time: "Unknown", conversation: [] };
        }

        item.querySelectorAll("ul.ujRzj > li").forEach(msg => {
          const headerEl = msg.querySelector("header .nonIntl");
          const sender = headerEl ? headerEl.textContent.trim() : "Me";

          msg.querySelectorAll("span.ogn1z").forEach(t => {
            const text = t.textContent.trim();
            if (text) currentBlock.conversation.push({ from: sender, text });
          });
        });
      });

      if (currentBlock && currentBlock.conversation.length > 0) {
        chat.push(currentBlock);
      }

      return { id: userId, name, chat };
    };

    const attemptExtract = async () => {
      await this.page.waitForFunction(
        (uid) => !!document.querySelector(`#cv-${uid}`),
        { timeout: 8000 },
        userId
      );
      await delay(800);
      return await this.page.evaluate(extractFromDOM, userId);
    };

    try {
      const result = await attemptExtract();
      if (!result) throw new Error("Chat container not ready");
      return result;

    } catch (err) {
      console.log("extractChatData failed, retrying...", err.message);

      await this.page.reload({ waitUntil: "networkidle2" });
      await delay(2000);
      await this.handlePopup();
      await this.openChat(userId);
      await delay(1500);

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
    let stable = 0;
    let previousVisibleKey = "";

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
            const statusTexts = statusParent
              ? Array.from(statusParent.querySelectorAll("span")).map(span => span.textContent.trim())
              : [];

            const cleanedStatus = statusTexts
              .map(t => t?.trim())
              .filter(t =>
                t &&
                t !== "·" &&
                t.length < 20 &&
                !t.includes("\n")
              );

            const fullText = cleanedStatus.join(" ").toLowerCase();
            const type = fullText.includes("say hi") ? "say_hi"
              : fullText.includes("new chat") ? "new_chat"
              : fullText.includes("new snap") ? "new_snap"
              : fullText.includes("opened") ? "opened"
              : fullText.includes("received") ? "received"
              : fullText.includes("delivered") ? "delivered"
              : null;

            return {
              id,
              name,
              status: {
                type,
                time: cleanedStatus.find(t => /\d+\s?[mhdw]/i.test(t)) || null,
                streak: cleanedStatus.find(t => t.includes("🔥")) || null,
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
        await this.page.mouse.wheel({ deltaY: 1800 });
      }

      await delay(500);

      const reachedEnd = scrollResult.moved && scrollResult.after >= scrollResult.max - 5;
      const visibleStuck = scrollResult.visibleIds === previousVisibleKey;
      const sizeStuck = statuses.size === prevSize;
      const grew = statuses.size > prevSize;

      if (grew) {
        stable = 0;
      } else if ((sizeStuck && visibleStuck) || reachedEnd) {
        stable++;
      } else {
        stable = 0;
      }

      if (stable >= 8) {
        if (targetCount && statuses.size < targetCount) {
          console.warn(`Friend status list stopped at ${statuses.size}/${targetCount}`);
        }
        break;
      }
      prevSize = statuses.size;
      previousVisibleKey = scrollResult.visibleIds;
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

  //select
  async useShortcut(shortcutsArray) {
    await this.waitForState("app_ready");
    const button = await this.page.$("button.YatIx.fGS78.eKaL7.Bnaur");
    if (button) {
      console.log("Send Button found!");
      await button.click();
    } else {
      console.log("Send Button not found.");
    }
    await delay(2000);
    for (const emoji of shortcutsArray) {
      const clicked = await this.page.$$eval(
        "div.THeKv button",
        (buttons, emoji) => {
          const btn = buttons.find((b) => b.textContent.trim() === emoji);
          if (btn) {
            btn.click();
            //now press the select
            return true;
          }
          return false;
        },
        emoji
      );

      if (clicked) {
        await this.page.waitForSelector("button.Y7u8A");
        await this.page.click("button.Y7u8A");
        const reclick = await this.page.$$eval(
          "div.THeKv button",
          (buttons, emoji) => {
            const btn = buttons.find((b) => b.textContent.trim() === emoji);
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          },
          emoji
        );
      }
      if (!clicked) {
        console.warn(`Shortcut "${emoji}" not found.`);
      }
    }
    //send button

    const sendButton = await this.page.$("button[type='submit']"); 
    await sendButton.click();
  }

  // add custom methods
  static extend(methods) {
    Object.assign(PrivateSnapchatEngine.prototype, methods);
  }
}
