import { SnapchatClient } from "../../src/index.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const credentials = {
  username: process.env.USER_NAME || process.env.SNAPCHAT_USERNAME,
  password: process.env.USER_PASSWORD || process.env.SNAPCHAT_PASSWORD,
};
const sessionKey = process.env.SNAPCHAT_SESSION_KEY || process.env.SNAPCHAT_USERNAME || credentials.username;

const client = new SnapchatClient({
  browser: { headless: false },
  session: { key: sessionKey },
});

try {
  await client.init();
  let loggedIn = await client.isLoggedIn();
  if (!loggedIn) {
    await client.login(credentials);
  }
  console.log("Logged in. Starting onEvent listener...");
  console.log("Send a Snapchat message/opened to trigger an event.\n");

  const listener = await client.onEvent((event) => {
    console.log("[" + new Date().toLocaleTimeString() + "]", event.trigger, "→", event.name, JSON.stringify(event.status));
  });

  // Keep running for 5 minutes max
  await new Promise((r) => setTimeout(r, 300000));
  await listener.stop();
  console.log("Stopped.");
} finally {
  await client.close();
}
