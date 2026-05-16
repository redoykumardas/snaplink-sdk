import express from "express";
import { SnapchatClient } from "../../src/index.js";

const app = express();
app.use(express.json());

const snapchat = new SnapchatClient({
  browser: { headless: true },
  session: { key: process.env.SNAPCHAT_USERNAME },
});

app.post("/init", async (_req, res) => {
  const state = await snapchat.init();
  res.json({ state });
});

app.get("/friends", async (req, res) => {
  const limit = Number(req.query.limit) || undefined;
  const friends = await snapchat.getFriends({ limit });
  res.json({ friends });
});

app.post("/messages", async (req, res) => {
  await snapchat.sendMessage(req.body.friendId, req.body.message);
  res.json({ ok: true });
});

app.listen(3000);
