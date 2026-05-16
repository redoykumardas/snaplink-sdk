export const selectors = Object.freeze({
  appReady: [
    "div.ReactVirtualized__Grid__innerScrollContainer",
    "div[role='listitem'] span[id^='title-']",
    "button[aria-label='Camera']",
    "button[data-testid='cameraButton']",
    "button.qJKfS",
  ],
  friends: {
    listItem: "div[role='listitem']",
    title: "div[role='listitem'] span[id^='title-']",
    virtualGrid: "div.ReactVirtualized__Grid__innerScrollContainer",
  },
  chat: {
    textbox: 'div[role="textbox"], div[contenteditable="true"]',
  },
  popups: {
    notNowText: "not now",
  },
});
