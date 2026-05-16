import { SnapchatClient } from "../../src/index.js";

const snapchat = new SnapchatClient({
  browser: { headless: false },
  session: { key: process.env.SNAPCHAT_USERNAME },
});

await snapchat.init();

if (!(await snapchat.isLoggedIn())) {
  await snapchat.login({
    username: process.env.SNAPCHAT_USERNAME,
    password: process.env.SNAPCHAT_PASSWORD,
  });
}

const watcher = await snapchat.watchMessages({
  triggers: ["received", "new_chat", "opened"],
  onMessage: async (event) => {
    if (event.trigger === "opened") {
      await snapchat.sendMessage(event.friendId, "I saw you opened my message. Want me to help?");
      return;
    }

    const latest = event.latestMessage;
    if (!latest) return;

    console.log(`Incoming message from ${event.name}:`, latest.text);
    await snapchat.sendMessage(event.friendId, "Thanks for your message. I will reply soon.");
  },
  onError: (error) => {
    console.error("Watcher error:", error);
  },
});

process.on("SIGINT", async () => {
  await watcher.stop();
  await snapchat.close();
  process.exit(0);
});
