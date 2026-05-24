export function extractFromDOM(userId) {
  function _checkSelectors(container) {
    return {
      hasT1yt2: !!container.querySelector("li.T1yt2"),
      hasUjRzj: !!container.querySelector("ul.ujRzj"),
      hasTimeLX6HN: !!container.querySelector("time.LX6HN"),
      anyLi: container.querySelectorAll("li").length,
    };
  }

  function _extractTime(messageLi) {
    const timeEl = messageLi.querySelector("time.LX6HN");
    if (timeEl) return timeEl.textContent.trim();
    const altTime = messageLi.querySelector("time");
    if (altTime) return altTime.textContent.trim();
    return null;
  }

  function _extractSender(msg) {
    const headerEl = msg.querySelector("header.R1ne3");
    if (headerEl) {
      return headerEl.querySelector(".nonIntl")?.textContent.trim() || headerEl.textContent.trim();
    }
    return null;
  }

  function _extractReactions(msg) {
    const reactionsEl = msg.querySelector("ul.PmTA8");
    if (!reactionsEl) return [];
    return Array.from(reactionsEl.querySelectorAll("span, img"))
      .map(el => el.textContent.trim() || el.getAttribute("alt") || "")
      .filter(t => t && /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(t));
  }

  function _extractMessageContent(msg) {
    const contentEl = msg.querySelector("div.KB4Aq.SOEIP.IPEgq");
    if (!contentEl) return null;
    const hasSnapPreview = contentEl.querySelector("svg, .y2oqI, .vwM69");
    const rawText = contentEl.textContent.trim();
    const cleaned = rawText.replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim();
    if (hasSnapPreview) return { type: "snap", text: cleaned || "[Snap]" };
    if (!cleaned || cleaned === "Click to view") return null;
    return { type: "text", text: cleaned };
  }

  function _extractMessageId(msg) {
    const idEl = msg.querySelector("[id^='msg-'], [id^='message-']");
    if (idEl) return idEl.id;
    const dataId = msg.getAttribute("data-message-id") || msg.getAttribute("data-id");
    if (dataId) return dataId;
    return null;
  }

  function _extractTimestamp(msg) {
    const stamp = msg.querySelector("time");
    if (stamp) {
      const ts = stamp.getAttribute("datetime") || stamp.getAttribute("data-timestamp");
      if (ts) return new Date(ts).getTime();
    }
    const dataTs = msg.getAttribute("data-timestamp") || msg.getAttribute("data-ts");
    if (dataTs) return !isNaN(Number(dataTs)) ? Number(dataTs) : new Date(dataTs).getTime();
    return null;
  }

  function _domFallbackExtract(container) {
    const chat = [];
    const pendingMessages = [];
    let currentBlock = null;
    const times = container.querySelectorAll("time");
    for (const t of times) {
      const li = t.closest("li") || t.parentElement?.closest("li");
      if (!li) continue;
      const dateText = t.textContent.trim();
      if (currentBlock && currentBlock.conversation.length > 0) chat.push(currentBlock);
      if (pendingMessages.length > 0) {
        currentBlock = { time: dateText, conversation: pendingMessages.splice(0) };
      } else {
        currentBlock = { time: dateText, conversation: [] };
      }
      let lastSender = "Me";
      const siblings = li.parentElement?.children;
      if (siblings) {
        let foundLi = false;
        for (const sib of siblings) {
          if (sib === li) { foundLi = true; continue; }
          if (!foundLi) continue;
          const text = sib.textContent?.trim();
          if (!text || text === dateText) continue;
          const sentByMe = !sib.querySelector("header");
          const sender = sentByMe ? "Me" : (sib.querySelector("header")?.textContent?.trim() || lastSender);
          lastSender = sender;
          currentBlock.conversation.push({ id: null, from: sender, text, type: "text", timestamp: null });
          if (currentBlock.conversation.length > 50) break;
        }
      }
    }
    return { chat, pendingMessages };
  }

  const container = document.querySelector(`#cv-${CSS.escape(userId)}`);
  if (!container) return null;

  const selectorReport = _checkSelectors(container);
  const knownSelectorsWork = selectorReport.hasT1yt2 || selectorReport.hasUjRzj || selectorReport.hasTimeLX6HN;

  const nameEl = document.querySelector(`#title-${CSS.escape(userId)}`);
  const name = nameEl ? nameEl.textContent.trim() : "Unknown";
  const chat = [];
  let currentBlock = null;
  let pendingMessages = [];
  let usedFallback = false;

  if (knownSelectorsWork) {
    const allItems = container.querySelectorAll("li.T1yt2");
    const items = Array.from(allItems).filter(li => li.textContent.trim().length > 0);
    if (!items.length) return { id: userId, name, chat: [] };

    for (const item of items) {
      const blockTime = _extractTime(item);
      if (blockTime) {
        if (pendingMessages.length > 0) {
          if (currentBlock) chat.push(currentBlock);
          currentBlock = { time: blockTime, conversation: pendingMessages.splice(0) };
        } else {
          if (currentBlock) chat.push(currentBlock);
          currentBlock = { time: blockTime, conversation: [] };
        }
        continue;
      }
      let lastSender = "Me";
      const msgItems = item.querySelectorAll("ul.ujRzj > li");
      if (!msgItems.length) continue;
      for (const msg of msgItems) {
        const sender = _extractSender(msg) || lastSender;
        lastSender = sender;
        const reactions = _extractReactions(msg);
        const content = _extractMessageContent(msg);
        if (!content) continue;
        const msgId = _extractMessageId(msg);
        const timestamp = _extractTimestamp(msg);
        let text = content.text;
        if (content.type === "snap" && text === "[Snap]" && sender === "Me") {
          text = "[Snap sent]";
        }
        const entry = { id: msgId, from: sender, text, type: content.type, timestamp };
        if (reactions.length > 0) entry.reactions = reactions;
        if (currentBlock) {
          currentBlock.conversation.push(entry);
        } else {
          pendingMessages.push(entry);
        }
      }
    }
  } else {
    console.warn(`extractChatData: known selectors failed for ${userId}, using fallback`);
    usedFallback = true;
    const fallback = _domFallbackExtract(container);
    chat.push(...fallback.chat);
    pendingMessages = fallback.pendingMessages;
  }

  if (currentBlock && currentBlock.conversation.length > 0) chat.push(currentBlock);
  if (pendingMessages.length > 0) chat.push({ time: "Unknown", conversation: pendingMessages });

  // Remove any degenerate entries (shouldn't happen, but guard against edge cases)
  for (const block of chat) {
    if (!block.conversation?.length) continue;
    block.conversation = block.conversation.filter(msg => msg.from && (msg.text !== undefined && msg.text !== null));
  }

  return { id: userId, name, chat, _fallback: usedFallback };
}

export function countVisibleMessages(userId) {
  const container = document.querySelector(`#cv-${CSS.escape(userId)}`);
  if (!container) return 0;
  let count = 0;
  const blocks = container.querySelectorAll("li.T1yt2");
  for (const block of blocks) {
    count += block.querySelectorAll("ul.ujRzj > li").length;
  }
  if (count === 0) {
    count = container.querySelectorAll("li.T1yt2 > ul > li, li > div.KB4Aq, li > div[id]").length;
  }
  return count;
}

export function estimateTotalMessages(userId) {
  const container = document.querySelector(`#cv-${CSS.escape(userId)}`);
  if (!container) return 0;
  const items = container.querySelectorAll("li.T1yt2, li");
  let total = 0;
  for (const item of items) {
    total += item.querySelectorAll("ul.ujRzj > li, li > div.KB4Aq, li > div").length;
  }
  return total;
}
