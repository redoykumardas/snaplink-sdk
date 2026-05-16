export const DEFAULT_SDK_CONFIG = Object.freeze({
  browser: {
    headless: false,
  },
  debug: {
    screenshots: false,
    directory: ".snapchat-debug",
  },
  session: {
    key: null,
  },
});

export function mergeConfig(base = {}, override = {}) {
  return {
    ...base,
    ...override,
    browser: {
      ...(base.browser ?? {}),
      ...(override.browser ?? {}),
    },
    debug: {
      ...(base.debug ?? {}),
      ...(override.debug ?? {}),
    },
    session: {
      ...(base.session ?? {}),
      ...(override.session ?? {}),
    },
  };
}
