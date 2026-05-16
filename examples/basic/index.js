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

const friends = await snapchat.getFriends({ limit: 100 });
console.log(friends);

await snapchat.close();
