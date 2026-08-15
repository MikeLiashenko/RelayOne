/**
 * RelayOne — Messenger controller
 *
 * Route-protected two-pane messenger wired to the REST API + realtime layer.
 * User content is rendered with textContent only (no innerHTML) to avoid XSS.
 */
import { getSession, logout, requireAuth, setSession } from "./auth/session.js";
import { api } from "./app/api.js";
import { createRealtime } from "./app/realtime.js";
import { createCalls } from "./app/calls/index.js";
import { createViewer } from "./app/viewer.js";
import { push } from "./app/push.js";
import { ACCENTS, getAccent, getThemePref, initTheme, setAccent, setTheme } from "./app/features/theme.js";
import { createFolders } from "./app/features/folders.js";
import { ROADMAP } from "./app/features/roadmap.js";
import {
  $,
  $$,
  avatarHue,
  clear,
  dayLabel,
  el,
  initials,
  timeRelative,
  timeShort,
} from "./app/dom.js";

const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];
const PAGE = 30;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const state = {
  me: null,
  chats: [],
  filter: "",
  activeId: null,
  activeChat: null, // ChatDetail
  messages: [],
  msgNodes: new Map(), // messageId -> element
  reply: null, // { id, senderId, content }
  editing: null, // messageId being edited
  hasMoreOlder: true,
  loadingOlder: false,
  presence: new Map(), // userId -> online
  typingTimers: new Map(), // userId -> timeout
  pins: [], // pinned messages in the active chat (newest first)
  pinIdx: 0, // which pin the bar currently points at
  viewedProfile: null,
  pendingAttachments: [], // uploaded, not-yet-sent attachments for the composer
};

const ATTACH_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const linkCache = new Map(); // url -> preview | null

let rt = null;
let calls = null;
let folders = null;
const viewer = createViewer();
let typingSentAt = 0;

const DRAFTS_KEY = "relayone.drafts";

/* -- Boot ------------------------------------------------------------------ */

(async () => {
  initTheme();

  const me = await requireAuth("index.html");
  if (!me) return;
  state.me = me;

  folders = createFolders({ getChats: () => state.chats, onChange: renderChatList });

  renderMe();
  wireStaticUI();
  wireFeatures();
  await loadChats();
  folders.render();

  $(".messenger").hidden = false;
  rt = createRealtime({ onEvent: handleRealtime, onStatus: setConnStatus });
  calls = createCalls({
    send: (obj) => rt.send(obj),
    getMe: () => state.me,
    resolveUser,
    resolveChat,
    getIceServers: () => api.getIceServers(),
  });
  window.addEventListener("beforeunload", () => {
    calls?.destroy();
    rt?.stop();
  });

  // Open a chat when arriving from a push notification (?chat=… or a message
  // posted by the service worker after focusing an existing tab).
  openChatFromQuery();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "open-chat" && e.data.chatId) openChatSafely(e.data.chatId);
    });
  }
})();

/** Open a chat by id if it's in the user's list (used by push deep-links). */
async function openChatSafely(chatId) {
  if (!state.chats.some((c) => c.id === chatId)) await loadChats();
  if (state.chats.some((c) => c.id === chatId)) openChat(chatId);
}

function openChatFromQuery() {
  try {
    const id = new URLSearchParams(location.search).get("chat");
    if (!id) return;
    // Clean the URL so a refresh doesn't keep reopening it.
    history.replaceState(null, "", location.pathname);
    openChatSafely(id);
  } catch {
    /* ignore */
  }
}

/* -- Sidebar / me ---------------------------------------------------------- */

function renderMe() {
  $('[data-role="me-name"]').textContent = state.me.displayName;
  $('[data-role="me-handle"]').textContent = `@${state.me.username}`;
  renderAvatar($('[data-role="me-avatar"]'), {
    name: state.me.displayName,
    avatarUrl: state.me.avatarUrl,
  });
  applyPresenceDot();
}

/**
 * Paint an avatar node: a cover image when a valid URL is set, otherwise a
 * deterministic gradient with the name's initial. Re-appends a presence dot.
 */
function renderAvatar(node, { name, avatarUrl, online = false } = {}) {
  clear(node);
  const url = safeAvatarUrl(avatarUrl);
  if (url) {
    node.classList.add("avatar--img");
    node.setAttribute("style", `background-image: url("${url}");`);
  } else {
    node.classList.remove("avatar--img");
    node.setAttribute("style", avatarStyle(name));
    node.append(document.createTextNode(initials(name)));
  }
  if (online) node.append(el("span", { class: "presence-dot", title: "Online" }));
}

/** renderAvatar that returns the node, for inline composition with el(). */
function withAvatar(node, opts) {
  renderAvatar(node, opts);
  return node;
}

/** Only http(s) URLs, escaped so they can't break out of the CSS url() context. */
function safeAvatarUrl(url) {
  if (typeof url !== "string") return null;
  const t = url.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  return encodeURI(t).replace(/["'()\\]/g, (c) => "%" + c.charCodeAt(0).toString(16));
}

function wireStaticUI() {
  $('[data-action="logout"]').addEventListener("click", async () => {
    rt?.stop();
    await logout();
    location.replace("index.html");
  });

  $('[data-role="chat-search"]').addEventListener("input", (e) => {
    onSearchInput(e.target.value);
  });

  $('[data-action="close-new-chat"]').addEventListener("click", closeNewChat);
  $('[data-action="back"]').addEventListener("click", () => {
    $(".messenger").dataset.view = "list";
  });

  $('[data-action="call-audio"]').addEventListener("click", () => startCall("audio"));
  $('[data-action="call-video"]').addEventListener("click", () => startCall("video"));
  $('[data-action="call-group-audio"]').addEventListener("click", () => startGroupCall("audio"));
  $('[data-action="call-group-video"]').addEventListener("click", () => startGroupCall("video"));

  $('[data-action="open-saved"]').addEventListener("click", openSaved);
  $('[data-action="jump-pin"]').addEventListener("click", jumpNextPin);
  $('[data-action="toggle-pins"]').addEventListener("click", togglePinsPanel);
  $('[data-action="close-pins"]').addEventListener("click", () => { $('[data-role="pinned-panel"]').hidden = true; });

  $('[data-action="edit-profile"]').addEventListener("click", openEditProfile);
  $('[data-action="view-profile"]').addEventListener("click", openViewProfile);
  $('[data-action="close-profile"]').addEventListener("click", closeViewProfile);
  $$('[data-action="close-edit-profile"]').forEach((b) =>
    b.addEventListener("click", closeEditProfile)
  );

  wireNewChatSearch();
  wireProfileForms();
  wireComposer();

  // Load older on scroll to top.
  $('[data-role="messages"]').addEventListener("scroll", (e) => {
    if (e.target.scrollTop < 60) loadOlder();
  });
}

/* -- Chats list ------------------------------------------------------------ */

async function loadChats() {
  const r = await api.listChats();
  if (r.ok) {
    state.chats = r.data;
    for (const c of state.chats) seedPresenceFromChat(c);
  }
  renderChatList();
}

function seedPresenceFromChat(chat) {
  const other = otherMember(chat);
  if (other) state.presence.set(other.id, Boolean(chat.online));
}

function otherMember(chat) {
  if (!chat || chat.type !== "direct") return null;
  return chat.members.find((m) => m.id !== state.me.id) ?? chat.members[0] ?? null;
}

function chatDisplay(chat) {
  if (chat.type === "saved") {
    return { name: "Saved Messages", avatarText: "★", avatarUrl: null, peerId: null };
  }
  if (chat.type !== "direct") {
    const fallback = chat.type === "channel" ? "Channel" : "Group";
    return {
      name: chat.title || fallback,
      avatarText: initials(chat.title || fallback[0]),
      avatarUrl: null,
      peerId: null,
    };
  }
  const other = otherMember(chat);
  return {
    name: other?.displayName ?? "Unknown",
    avatarText: initials(other?.displayName ?? "?"),
    avatarUrl: other?.avatarUrl ?? null,
    peerId: other?.id ?? null,
  };
}

function renderChatList() {
  const listEl = $('[data-role="chat-list"]');
  const emptyEl = $('[data-role="chats-empty"]');
  clear(listEl);

  const filtered = state.chats.filter((chat) => {
    if (chat.type === "saved") return false; // reached via the Saved Messages entry
    if (folders && !folders.matches(chat)) return false;
    if (!state.filter) return true;
    const { name } = chatDisplay(chat);
    const last = chat.lastMessage?.content ?? "";
    return (
      name.toLowerCase().includes(state.filter) ||
      last.toLowerCase().includes(state.filter)
    );
  });

  if (state.chats.length === 0) {
    emptyEl.hidden = false;
    emptyEl.querySelector('[data-role="empty-text"]').textContent =
      "No conversations yet. Start one with the + button.";
    folders?.render();
    return;
  }
  emptyEl.hidden = true;

  if (filtered.length === 0) {
    listEl.append(
      el("li", { class: "chat-list__empty" },
        state.filter ? "No chats match your search." : "No chats in this folder.")
    );
    folders?.render();
    return;
  }

  for (const chat of filtered) {
    const { name, avatarUrl, peerId } = chatDisplay(chat);
    const online = peerId ? state.presence.get(peerId) : false;
    const last = chat.lastMessage;
    const draft = getDraft(chat.id);
    const preview = last
      ? (last.deletedAt ? "Message deleted" : last.content ?? "Attachment")
      : "No messages yet";
    const mine = last && last.senderId === state.me.id;

    const avatarNode = el("div", { class: "chat-item__avatar" });
    renderAvatar(avatarNode, { name, avatarUrl, online });

    const previewNode = draft
      ? el("span", { class: "chat-item__preview chat-item__preview--draft" },
          el("span", { class: "chat-item__draft" }, "Draft: "), draft)
      : el("span", { class: "chat-item__preview" }, mine ? `You: ${preview}` : preview);

    const menuBtn = el("button", {
      class: "chat-item__menu",
      type: "button",
      title: "Folders",
      "aria-label": "Chat folders",
      onClick: (e) => { e.stopPropagation(); folders?.openChatMenu(chat.id, e.currentTarget); },
    }, "⋮");

    const item = el(
      "li",
      {
        class:
          "chat-item" +
          (chat.id === state.activeId ? " is-active" : "") +
          (chat.unreadCount > 0 ? " has-unread" : ""),
        dataset: { chatId: chat.id },
        onClick: () => openChat(chat.id),
      },
      avatarNode,
      el(
        "div",
        { class: "chat-item__body" },
        el(
          "div",
          { class: "chat-item__row" },
          el("span", { class: "chat-item__name" }, name),
          folders?.isFav(chat.id) ? el("span", { class: "chat-item__fav", title: "Favorite" }, "★") : null,
          el("span", { class: "chat-item__time" }, last ? timeRelative(last.createdAt) : "")
        ),
        el(
          "div",
          { class: "chat-item__row" },
          previewNode,
          chat.unreadCount > 0
            ? el("span", { class: "chat-item__badge" }, String(chat.unreadCount))
            : null
        )
      ),
      menuBtn
    );
    listEl.append(item);
  }

  folders?.render();
}

function avatarStyle(seed) {
  const h = avatarHue(seed);
  return `background: linear-gradient(135deg, hsl(${h} 80% 55%), hsl(${(h + 40) % 360} 80% 50%));`;
}

/* -- Global search (chats + people + messages) ----------------------------- */

let searchSeq = 0;
let searchTimer = null;
const searchData = { q: "", chats: [], users: null, messages: null }; // null = loading

function onSearchInput(raw) {
  const q = raw.trim();
  state.filter = q.toLowerCase();
  const searching = q.length > 0;
  setSearchMode(searching);

  if (!searching) {
    clearTimeout(searchTimer);
    clear($('[data-role="search-results"]'));
    renderChatList();
    return;
  }

  // Instant local part: matching chats. People + message text load debounced.
  searchData.q = q;
  searchData.chats = matchChats(q);
  searchData.users = null;
  searchData.messages = null;
  renderSearchResults();

  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  searchTimer = setTimeout(() => runRemoteSearch(q, seq), 250);
}

/** Swap the sidebar between its normal browsing list and search results. */
function setSearchMode(active) {
  $('[data-role="search-results"]').hidden = !active;
  const foldersEl = $('[data-role="folders"]');
  if (foldersEl) foldersEl.hidden = active;
  const saved = $(".saved-entry");
  if (saved) saved.hidden = active;
  $('[data-role="chat-list"]').hidden = active;
  if (active) $('[data-role="chats-empty"]').hidden = true;
}

function matchChats(q) {
  const lc = q.toLowerCase();
  return state.chats
    .filter((chat) => {
      if (chat.type === "saved") return false;
      const { name } = chatDisplay(chat);
      const last = chat.lastMessage?.content ?? "";
      return name.toLowerCase().includes(lc) || last.toLowerCase().includes(lc);
    })
    .slice(0, 8);
}

async function runRemoteSearch(q, seq) {
  const [users, msgs] = await Promise.all([
    api.searchUsers(q),
    api.searchMessages(q),
  ]);
  if (seq !== searchSeq) return; // a newer keystroke superseded this one
  searchData.users = users.ok ? users.data : [];
  searchData.messages = msgs.ok ? msgs.data : [];
  renderSearchResults();
}

function renderSearchResults() {
  const wrap = $('[data-role="search-results"]');
  clear(wrap);

  if (searchData.chats.length) {
    wrap.append(searchGroup("Chats", searchData.chats.map(chatResultNode)));
  }

  if (searchData.users === null) {
    wrap.append(searchGroup("People", [searchLoadingNode()]));
  } else if (searchData.users.length) {
    wrap.append(searchGroup("People", searchData.users.map(personResultNode)));
  }

  if (searchData.messages === null) {
    wrap.append(searchGroup("Messages", [searchLoadingNode()]));
  } else if (searchData.messages.length) {
    wrap.append(searchGroup("Messages", searchData.messages.map(messageResultNode)));
  }

  const settled = searchData.users !== null && searchData.messages !== null;
  const empty =
    !searchData.chats.length &&
    (searchData.users?.length ?? 0) === 0 &&
    (searchData.messages?.length ?? 0) === 0;
  if (settled && empty) {
    wrap.append(el("div", { class: "search-empty" }, `No results for “${searchData.q}”.`));
  }
}

function searchGroup(title, items) {
  return el(
    "div",
    { class: "search-group" },
    el("div", { class: "search-group__title" }, title),
    el("ul", { class: "search-group__list" }, ...items)
  );
}

function searchLoadingNode() {
  return el("li", { class: "search-loading" }, "Searching…");
}

function chatResultNode(chat) {
  const { name, avatarUrl, peerId } = chatDisplay(chat);
  const online = peerId ? state.presence.get(peerId) : false;
  const last = chat.lastMessage;
  const preview = last
    ? last.deletedAt
      ? "Message deleted"
      : last.content ?? "Attachment"
    : "No messages yet";
  const avatar = el("div", { class: "search-item__avatar" });
  renderAvatar(avatar, { name, avatarUrl, online });
  return el(
    "li",
    { class: "search-item", onClick: () => openSearchResult(() => openChat(chat.id)) },
    avatar,
    el(
      "div",
      { class: "search-item__body" },
      el("span", { class: "search-item__name" }, name),
      el("span", { class: "search-item__sub" }, preview)
    )
  );
}

function personResultNode(u) {
  const avatar = el("div", { class: "search-item__avatar" });
  renderAvatar(avatar, { name: u.displayName, avatarUrl: u.avatarUrl });
  return el(
    "li",
    { class: "search-item", onClick: () => openSearchResult(() => startChatWith(u)) },
    avatar,
    el(
      "div",
      { class: "search-item__body" },
      el("span", { class: "search-item__name" }, u.displayName),
      el("span", { class: "search-item__sub" }, `@${u.username}`)
    )
  );
}

function messageResultNode(m) {
  const chat = state.chats.find((c) => c.id === m.chatId);
  const disp = chat ? chatDisplay(chat) : { name: "Chat", avatarUrl: null };
  const avatar = el("div", { class: "search-item__avatar" });
  renderAvatar(avatar, { name: disp.name, avatarUrl: disp.avatarUrl });
  return el(
    "li",
    { class: "search-item", onClick: () => openSearchResult(() => openChat(m.chatId, m.id)) },
    avatar,
    el(
      "div",
      { class: "search-item__body" },
      el("span", { class: "search-item__name" }, disp.name),
      el("span", { class: "search-item__sub" }, m.content ?? "")
    )
  );
}

/** Clear the search box, leave search mode, then run the chosen action. */
function openSearchResult(action) {
  const input = $('[data-role="chat-search"]');
  input.value = "";
  state.filter = "";
  clearTimeout(searchTimer);
  searchSeq++;
  clear($('[data-role="search-results"]'));
  setSearchMode(false);
  action();
}

/* -- Open a chat ----------------------------------------------------------- */

async function openChat(id, highlightId = null) {
  state.activeId = id;
  state.reply = null;
  state.editing = null;
  state.hasMoreOlder = true;
  state.pins = [];
  state.pinIdx = 0;
  resetPinnedUI();
  clearPendingAttachments();
  updateReplyBar();
  restoreDraft(id);
  renderChatList();

  $('[data-role="pane-empty"]').hidden = true;
  $('[data-role="chat-view"]').hidden = false;
  $(".messenger").dataset.view = "chat";

  const msgEl = $('[data-role="messages"]');
  clear(msgEl);
  state.msgNodes.clear();
  $('[data-role="msg-loader"]').hidden = false;

  const [detail, messages] = await Promise.all([
    api.getChat(id),
    api.listMessages(id, { limit: PAGE }),
  ]);
  $('[data-role="msg-loader"]').hidden = true;

  if (!detail.ok || !messages.ok) {
    msgEl.append(el("div", { class: "messages__error" }, "Couldn’t load this conversation."));
    return;
  }

  state.activeChat = detail.data;
  for (const m of detail.data.memberStates) state.presence.set(m.userId, m.online);
  state.messages = messages.data;
  state.hasMoreOlder = messages.data.length === PAGE;

  renderHeader();
  renderMessages();
  markReadLatest();
  loadPins(id);
  if (highlightId) revealMessage(highlightId);
}

/**
 * Scroll to and flash a message, loading older history (bounded) until it's
 * found — used when jumping to a global-search result that may be far back.
 */
async function revealMessage(messageId) {
  const chatId = state.activeId;
  const tryJump = () => {
    if (state.msgNodes.has(messageId)) {
      jumpToMessage(messageId);
      return true;
    }
    return false;
  };
  if (tryJump()) return;
  for (let i = 0; i < 10 && state.hasMoreOlder; i++) {
    if (state.activeId !== chatId) return; // user switched chats
    await loadOlder();
    if (tryJump()) return;
  }
}

function renderHeader() {
  const chat = state.activeChat;
  const { name, avatarUrl } = chatDisplay(chat);
  renderAvatar($('[data-role="ch-avatar"]'), { name, avatarUrl });
  if (chat.type === "saved") {
    const av = $('[data-role="ch-avatar"]');
    av.textContent = "★";
    av.classList.add("chat-header__avatar--saved");
  } else {
    $('[data-role="ch-avatar"]').classList.remove("chat-header__avatar--saved");
  }
  $('[data-role="ch-name"]').textContent = name;
  // Calls are 1:1 in this version — offered on direct chats only.
  const actions = $(".chat-header__actions");
  if (actions) {
    const isDirect = chat.type === "direct";
    const isGroupy = chat.type === "group" || chat.type === "channel";
    actions.hidden = !(isDirect || isGroupy);
    $$('[data-call-kind="direct"]', actions).forEach((b) => (b.hidden = !isDirect));
    $$('[data-call-kind="group"]', actions).forEach((b) => (b.hidden = !isGroupy));
  }
  renderHeaderStatus();
}

function renderHeaderStatus() {
  const chat = state.activeChat;
  const statusEl = $('[data-role="ch-status"]');
  if (!chat) return;
  if (chat.type === "saved") {
    statusEl.classList.remove("is-typing");
    statusEl.textContent = "Notes, files & links — just for you";
    return;
  }
  if (chat.type !== "direct") {
    const n = chat.members.length;
    statusEl.textContent =
      chat.type === "channel" ? `${n} subscriber${n === 1 ? "" : "s"}` : `${n} member${n === 1 ? "" : "s"}`;
    return;
  }
  const other = otherMember(chat);
  const typing = other && state.typingTimers.has(other.id);
  if (typing) {
    statusEl.textContent = "typing…";
    statusEl.classList.add("is-typing");
  } else {
    statusEl.classList.remove("is-typing");
    statusEl.textContent = other && state.presence.get(other.id) ? "online" : "offline";
  }
}

/* -- Messages rendering ---------------------------------------------------- */

function renderMessages() {
  const msgEl = $('[data-role="messages"]');
  clear(msgEl);
  state.msgNodes.clear();

  let lastDay = null;
  for (const m of state.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      msgEl.append(el("div", { class: "day-sep" }, el("span", {}, dayLabel(m.createdAt))));
      lastDay = day;
    }
    const node = messageNode(m);
    state.msgNodes.set(m.id, node);
    msgEl.append(node);
  }
  scrollToBottom();
  refreshReceipts();
}

function senderName(senderId) {
  if (senderId === state.me.id) return "You";
  const u = state.activeChat?.members.find((m) => m.id === senderId);
  return u?.displayName ?? "Unknown";
}

function messageNode(m) {
  const mine = m.senderId === state.me.id;
  const deleted = Boolean(m.deletedAt);

  const bubbleChildren = [];

  // Group / channel chats: show sender name on others' messages.
  const t = state.activeChat?.type;
  if (!mine && (t === "group" || t === "channel") && !deleted) {
    bubbleChildren.push(el("div", { class: "msg__sender" }, senderName(m.senderId)));
  }

  // Reply quote — click to jump to the original message.
  if (m.replyTo) {
    bubbleChildren.push(
      el(
        "div",
        {
          class: "msg__reply msg__reply--link",
          title: "Go to message",
          onClick: (e) => { e.stopPropagation(); jumpToMessage(m.replyTo.id); },
        },
        el("span", { class: "msg__reply-name" }, senderName(m.replyTo.senderId)),
        el("span", { class: "msg__reply-text" }, m.replyTo.content ?? "Message unavailable")
      )
    );
  }

  // Attachments (display-only for now).
  if (!deleted && m.attachments?.length) {
    const wrap = el("div", { class: "msg__attachments" });
    for (const a of m.attachments) wrap.append(attachmentNode(a));
    bubbleChildren.push(wrap);
  }

  // Text.
  if (deleted) {
    bubbleChildren.push(el("div", { class: "msg__text msg__text--deleted" }, "This message was deleted"));
  } else if (m.content) {
    bubbleChildren.push(el("div", { class: "msg__text" }, m.content));
  }

  // Link preview card (first URL in the text).
  if (!deleted && m.content) {
    const url = firstUrl(m.content);
    if (url) {
      const card = el("a", {
        class: "msg__link-card is-loading",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        onClick: (e) => e.stopPropagation(),
      });
      bubbleChildren.push(card);
      attachLinkPreview(card, url);
    }
  }

  // Meta line: pinned + edited + time + receipt.
  const meta = el(
    "div",
    { class: "msg__meta" },
    m.pinnedAt && !deleted ? el("span", { class: "msg__pin", title: "Pinned" }, "📌") : null,
    m.editedAt && !deleted ? el("span", { class: "msg__edited" }, "edited") : null,
    el("span", { class: "msg__time" }, timeShort(m.createdAt)),
    mine && !deleted ? el("span", { class: "msg__receipt", dataset: { role: "receipt" } }, "✓") : null
  );
  bubbleChildren.push(meta);

  // Reactions.
  const reactions = groupReactions(m.reactions);
  if (reactions.length) {
    const rrow = el("div", { class: "msg__reactions" });
    for (const r of reactions) {
      rrow.append(
        el(
          "button",
          {
            class: "reaction" + (r.mine ? " is-mine" : ""),
            type: "button",
            onClick: () => toggleReaction(m, r.emoji, r.mine),
          },
          `${r.emoji} ${r.count}`
        )
      );
    }
    bubbleChildren.push(rrow);
  }

  const bubble = el("div", { class: "msg__bubble" }, ...bubbleChildren);

  // Hover actions.
  const actions = deleted ? null : messageActions(m, mine);

  const row = el(
    "div",
    { class: "msg" + (mine ? " msg--mine" : " msg--other"), dataset: { id: m.id } },
    mine ? [actions, bubble] : [bubble, actions]
  );
  return row;
}

function messageActions(m, mine) {
  const wrap = el("div", { class: "msg__actions" });
  wrap.append(
    el("button", { class: "msg__action", type: "button", title: "React",
      onClick: (e) => openReactionPicker(e, m) }, "🙂"),
    el("button", { class: "msg__action", type: "button", title: "Reply",
      onClick: () => startReply(m) }, "↩"),
    el("button", { class: "msg__action" + (m.pinnedAt ? " is-active" : ""), type: "button",
      title: m.pinnedAt ? "Unpin" : "Pin", onClick: () => togglePin(m) }, "📌")
  );
  if (mine) {
    wrap.append(
      el("button", { class: "msg__action", type: "button", title: "Edit",
        onClick: () => startEdit(m) }, "✎"),
      el("button", { class: "msg__action", type: "button", title: "Delete",
        onClick: () => deleteMessage(m) }, "🗑")
    );
  }
  return wrap;
}

function groupReactions(reactions = []) {
  const map = new Map();
  for (const r of reactions) {
    const cur = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    cur.count += 1;
    if (r.userId === state.me.id) cur.mine = true;
    map.set(r.emoji, cur);
  }
  return [...map.values()];
}

function replaceMessageNode(m) {
  const old = state.msgNodes.get(m.id);
  if (!old) return;
  const node = messageNode(m);
  state.msgNodes.set(m.id, node);
  old.replaceWith(node);
}

/* -- Read receipts --------------------------------------------------------- */

function refreshReceipts() {
  const chat = state.activeChat;
  if (!chat || chat.type !== "direct") return;
  const other = otherMember(chat);
  const otherState = chat.memberStates.find((s) => s.userId === other?.id);
  const readAt = otherState?.lastReadAt ? Date.parse(otherState.lastReadAt) : 0;
  const online = other ? state.presence.get(other.id) : false;

  for (const m of state.messages) {
    if (m.senderId !== state.me.id || m.deletedAt) continue;
    const node = state.msgNodes.get(m.id);
    const receipt = node?.querySelector('[data-role="receipt"]');
    if (!receipt) continue;
    if (Date.parse(m.createdAt) <= readAt) {
      receipt.textContent = "✓✓";
      receipt.className = "msg__receipt is-read";
    } else if (online) {
      receipt.textContent = "✓✓";
      receipt.className = "msg__receipt is-delivered";
    } else {
      receipt.textContent = "✓";
      receipt.className = "msg__receipt";
    }
  }
}

/* -- Pagination ------------------------------------------------------------ */

async function loadOlder() {
  if (!state.activeId || state.loadingOlder || !state.hasMoreOlder) return;
  const oldest = state.messages[0];
  if (!oldest) return;
  state.loadingOlder = true;
  $('[data-role="msg-loader"]').hidden = false;

  const r = await api.listMessages(state.activeId, { limit: PAGE, before: oldest.createdAt });
  $('[data-role="msg-loader"]').hidden = true;
  state.loadingOlder = false;
  if (!r.ok || r.data.length === 0) {
    state.hasMoreOlder = false;
    return;
  }
  state.hasMoreOlder = r.data.length === PAGE;

  const msgEl = $('[data-role="messages"]');
  const prevHeight = msgEl.scrollHeight;
  state.messages = [...r.data, ...state.messages];
  renderMessages();
  // Preserve scroll position after prepending.
  msgEl.scrollTop = msgEl.scrollHeight - prevHeight;
}

/* -- Composer -------------------------------------------------------------- */

function wireComposer() {
  const input = $('[data-role="composer-input"]');
  const form = $('[data-role="composer"]');

  input.addEventListener("input", () => {
    autoGrow(input);
    updateSendEnabled();
    // Persist an unsent draft per chat (but not while editing an existing message).
    if (state.activeId && !state.editing) setDraft(state.activeId, input.value);
    sendTyping();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitComposer();
  });

  // File attachments: button, paste, and drag-and-drop.
  $('[data-action="attach"]').addEventListener("click", () => $('[data-role="attach-input"]').click());
  $('[data-role="attach-input"]').addEventListener("change", onComposerFilesChosen);
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFilesToComposer(files);
    }
  });
  wireDragAndDrop();

  $('[data-action="cancel-reply"]').addEventListener("click", cancelReplyOrEdit);
}

/** Drop files anywhere on the open chat to attach them. */
function wireDragAndDrop() {
  const zone = $('[data-role="chat-view"]');
  const overlay = $('[data-role="drop-overlay"]');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

  zone.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || !state.activeId) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  zone.addEventListener("dragover", (e) => {
    if (hasFiles(e) && state.activeId) e.preventDefault();
  });
  zone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  zone.addEventListener("drop", (e) => {
    depth = 0;
    overlay.hidden = true;
    if (!hasFiles(e) || !state.activeId) return;
    e.preventDefault();
    addFilesToComposer([...(e.dataTransfer.files || [])]);
  });
}

/* -- Composer attachments -------------------------------------------------- */

function attachmentKind(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "voice";
  return "document";
}

/** Upload one file via the attachments flow; resolves to the public attachment. */
async function uploadAttachment(file) {
  const created = await api.createUpload({
    kind: attachmentKind(file.type || ""),
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    fileName: file.name,
  });
  if (!created.ok) throw new Error(created.error?.message ?? "Couldn’t start the upload.");
  const { attachment, upload } = created.data;
  const token = getSession()?.token;
  const res = await fetch(upload.uploadUrl, {
    method: upload.method || "PUT",
    headers: { ...(upload.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  if (!res.ok) throw new Error("Upload failed. Please try again.");
  return attachment;
}

async function onComposerFilesChosen(e) {
  const files = [...(e.target.files || [])];
  e.target.value = ""; // allow re-picking the same file
  await addFilesToComposer(files);
}

/** Validate + upload a batch of files into the composer tray (button/paste/drop). */
async function addFilesToComposer(files) {
  if (!state.activeId) return;
  for (const file of [...files]) {
    if (!file) continue;
    if (file.size > ATTACH_MAX_BYTES) {
      flashComposerError(`“${file.name}” is too large (max 25 MB).`);
      continue;
    }
    const placeholder = { id: null, fileName: file.name, sizeBytes: file.size, kind: attachmentKind(file.type || ""), uploading: true };
    state.pendingAttachments.push(placeholder);
    renderAttachTray();
    try {
      const attachment = await uploadAttachment(file);
      Object.assign(placeholder, attachment, { uploading: false });
    } catch (err) {
      state.pendingAttachments = state.pendingAttachments.filter((a) => a !== placeholder);
      flashComposerError(err?.message ?? "Upload failed.");
    }
    renderAttachTray();
    updateSendEnabled();
  }
}

function renderAttachTray() {
  const tray = $('[data-role="attach-tray"]');
  clear(tray);
  tray.hidden = state.pendingAttachments.length === 0;
  for (const a of state.pendingAttachments) {
    const chip = el("div", { class: "attach-chip" + (a.uploading ? " is-uploading" : "") });
    if (a.kind === "image" && a.url) {
      chip.append(el("span", { class: "attach-chip__thumb", style: `background-image:url("${cssUrlEscape(a.url)}")` }));
    } else {
      chip.append(el("span", { class: "attach-chip__icon" }, a.kind === "video" ? "🎬" : a.kind === "voice" ? "🎵" : "📄"));
    }
    chip.append(
      el("span", { class: "attach-chip__meta" },
        el("span", { class: "attach-chip__name" }, a.fileName || "file"),
        el("span", { class: "attach-chip__size" }, humanSize(a.sizeBytes)))
    );
    if (a.uploading) {
      chip.append(el("span", { class: "attach-chip__spin" }));
    } else {
      chip.append(
        el("button", { class: "attach-chip__x", type: "button", "aria-label": "Remove",
          onClick: () => { state.pendingAttachments = state.pendingAttachments.filter((x) => x !== a); renderAttachTray(); updateSendEnabled(); } }, "✕")
      );
    }
    tray.append(chip);
  }
}

function clearPendingAttachments() {
  state.pendingAttachments = [];
  renderAttachTray();
}

function updateSendEnabled() {
  const input = $('[data-role="composer-input"]');
  const ready = state.pendingAttachments.some((a) => !a.uploading);
  $('[data-action="send"]').disabled = input.value.trim() === "" && !ready;
}

function autoGrow(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

/* -- Drafts ---------------------------------------------------------------- */

function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function getDraft(chatId) {
  return (readDrafts()[chatId] ?? "").trim() ? readDrafts()[chatId] : "";
}
function setDraft(chatId, text) {
  const all = readDrafts();
  if (text && text.trim()) all[chatId] = text;
  else delete all[chatId];
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}
function clearDraft(chatId) {
  setDraft(chatId, "");
}
/** Load a chat's saved draft into the composer (called when opening a chat). */
function restoreDraft(chatId) {
  const input = $('[data-role="composer-input"]');
  input.value = getDraft(chatId);
  autoGrow(input);
  $('[data-action="send"]').disabled = input.value.trim() === "";
}

async function submitComposer() {
  const input = $('[data-role="composer-input"]');
  const content = input.value.trim();
  const ready = state.pendingAttachments.filter((a) => !a.uploading && a.id);
  if ((!content && ready.length === 0) || !state.activeId) return;

  const sendBtn = $('[data-action="send"]');
  sendBtn.disabled = true;
  sendBtn.classList.add("is-loading");

  let r;
  if (state.editing) {
    r = await api.editMessage(state.editing, content);
  } else {
    r = await api.sendMessage(state.activeId, {
      ...(content ? { content } : {}),
      ...(state.reply ? { replyToId: state.reply.id } : {}),
      ...(ready.length ? { attachmentIds: ready.map((a) => a.id) } : {}),
    });
  }

  sendBtn.classList.remove("is-loading");
  if (!r.ok) {
    sendBtn.disabled = false;
    flashComposerError(r.error?.message ?? "Couldn’t send. Try again.");
    return;
  }

  input.value = "";
  autoGrow(input);
  if (!state.editing) {
    clearDraft(state.activeId);
    clearPendingAttachments();
    renderChatList(); // drop the draft indicator immediately
  }
  state.editing = null;
  state.reply = null;
  updateReplyBar();
  updateSendEnabled();
  // The realtime echo will append/patch the message for us.
}

function flashComposerError(msg) {
  const banner = $('[data-role="composer-error"]');
  banner.textContent = msg;
  banner.hidden = false;
  setTimeout(() => (banner.hidden = true), 3000);
}

function sendTyping() {
  const now = Date.now();
  if (!state.activeId || now - typingSentAt < 2000) return;
  typingSentAt = now;
  rt?.send({ type: "typing", chatId: state.activeId, isTyping: true });
}

/* -- Reply / edit ---------------------------------------------------------- */

function startReply(m) {
  state.editing = null;
  state.reply = { id: m.id, senderId: m.senderId, content: m.content };
  updateReplyBar();
  $('[data-role="composer-input"]').focus();
}

function startEdit(m) {
  state.reply = null;
  state.editing = m.id;
  const input = $('[data-role="composer-input"]');
  input.value = m.content ?? "";
  autoGrow(input);
  $('[data-action="send"]').disabled = input.value.trim() === "";
  updateReplyBar();
  input.focus();
}

function cancelReplyOrEdit() {
  state.reply = null;
  if (state.editing) {
    state.editing = null;
    const input = $('[data-role="composer-input"]');
    input.value = "";
    autoGrow(input);
    $('[data-action="send"]').disabled = true;
  }
  updateReplyBar();
}

function updateReplyBar() {
  const bar = $('[data-role="reply-bar"]');
  if (state.editing) {
    bar.hidden = false;
    bar.dataset.mode = "edit";
    $('[data-role="reply-label"]').textContent = "Editing message";
    $('[data-role="reply-text"]').textContent = state.reply?.content ?? "";
    return;
  }
  if (state.reply) {
    bar.hidden = false;
    bar.dataset.mode = "reply";
    $('[data-role="reply-label"]').textContent = `Replying to ${senderName(state.reply.senderId)}`;
    $('[data-role="reply-text"]').textContent = replyPreviewText(state.reply);
    return;
  }
  bar.hidden = true;
}

/** Preview text for the reply bar — handles attachment-only / empty messages. */
function replyPreviewText(r) {
  if (r.content) return r.content;
  return "Attachment";
}

async function deleteMessage(m) {
  if (!confirm("Delete this message?")) return;
  await api.deleteMessage(m.id);
  // realtime echo tombstones it.
}

/* -- Reactions ------------------------------------------------------------- */

let reactionPickerEl = null;

function openReactionPicker(event, m) {
  closeReactionPicker();
  const picker = el(
    "div",
    { class: "reaction-picker" },
    ...REACTIONS.map((emoji) =>
      el("button", { type: "button", class: "reaction-picker__btn",
        onClick: () => { toggleReaction(m, emoji, hasMyReaction(m, emoji)); closeReactionPicker(); } }, emoji)
    )
  );
  document.body.append(picker);
  const rect = event.currentTarget.getBoundingClientRect();
  picker.style.top = `${window.scrollY + rect.bottom + 6}px`;
  picker.style.left = `${window.scrollX + rect.left}px`;
  reactionPickerEl = picker;
  setTimeout(() => document.addEventListener("click", onDocClickPicker, { once: true }), 0);
}

function onDocClickPicker() {
  closeReactionPicker();
}
function closeReactionPicker() {
  reactionPickerEl?.remove();
  reactionPickerEl = null;
}

function hasMyReaction(m, emoji) {
  return (m.reactions ?? []).some((r) => r.emoji === emoji && r.userId === state.me.id);
}

async function toggleReaction(m, emoji, mine) {
  if (mine) await api.removeReaction(m.id, emoji);
  else await api.addReaction(m.id, emoji);
  // realtime echo updates the message.
}

/* -- Profile: view + edit -------------------------------------------------- */

function wireProfileForms() {
  const form = $('[data-role="edit-profile-form"]');
  form.addEventListener("submit", saveProfile);

  $('[data-role="ep-bio"]').addEventListener("input", updateBioCount);

  // Live avatar preview as the name / URL fields change.
  $('[data-role="ep-displayName"]').addEventListener("input", previewEpAvatar);
  $('[data-role="ep-avatarUrl"]').addEventListener("input", () => {
    previewEpAvatar();
    toggleEpRemove();
  });

  // File upload: click the avatar (or use the hidden input) to pick a photo.
  $('[data-action="pick-avatar"]').addEventListener("click", () =>
    $('[data-role="ep-file"]').click()
  );
  $('[data-role="ep-file"]').addEventListener("change", onAvatarFileChosen);
  $('[data-action="remove-avatar"]').addEventListener("click", () => setEpAvatarUrl(""));

  // Backdrop clicks dismiss.
  $('[data-role="edit-profile-modal"]').addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeEditProfile();
  });
  $('[data-role="profile-modal"]').addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeViewProfile();
  });

  // Esc closes whichever modal is open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$('[data-role="edit-profile-modal"]').hidden) closeEditProfile();
    else if (!$('[data-role="profile-modal"]').hidden) closeViewProfile();
    else if (!$('[data-role="new-chat-modal"]').hidden) closeNewChat();
  });
}

/* View another member's profile (direct chats). */
function openViewProfile() {
  const chat = state.activeChat;
  if (!chat || chat.type === "group") return;
  const other = otherMember(chat);
  if (!other) return;
  fillProfile(other);
  $('[data-role="profile-modal"]').hidden = false;
}
function closeViewProfile() {
  $('[data-role="profile-modal"]').hidden = true;
}

function fillProfile(user) {
  state.viewedProfile = user;
  renderAvatar($('[data-role="pv-avatar"]'), { name: user.displayName, avatarUrl: user.avatarUrl });
  $('[data-role="pv-name"]').textContent = user.displayName ?? "Unknown";
  $('[data-role="pv-handle"]').textContent = user.username ? `@${user.username}` : "";

  const bioEl = $('[data-role="pv-bio"]');
  bioEl.textContent = user.bio ?? "";
  bioEl.hidden = !user.bio;

  $('[data-role="pv-joined"]').textContent = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString([], { month: "long", year: "numeric" })
    : "—";

  // Groups in common: groups where both this user and I are members.
  const common = state.chats.filter(
    (c) => c.type === "group" && c.members?.some((m) => m.id === user.id)
  );
  const row = $('[data-role="pv-common-row"]');
  if (common.length) {
    $('[data-role="pv-common"]').textContent = common
      .map((c) => c.title || "Group")
      .join(", ");
    row.hidden = false;
  } else {
    row.hidden = true;
  }
}

/* Edit your own profile. */
function openEditProfile() {
  const me = state.me;
  $('[data-role="ep-displayName"]').value = me.displayName ?? "";
  $('[data-role="ep-username"]').value = me.username ?? "";
  $('[data-role="ep-avatarUrl"]').value = me.avatarUrl ?? "";
  $('[data-role="ep-bio"]').value = me.bio ?? "";
  updateBioCount();
  renderAvatar($('[data-role="ep-avatar"]'), { name: me.displayName, avatarUrl: me.avatarUrl });
  toggleEpRemove();
  setAvatarBusy(false);
  setEpError("");
  $('[data-role="edit-profile-modal"]').hidden = false;
  $('[data-role="ep-displayName"]').focus();
}
function closeEditProfile() {
  $('[data-role="edit-profile-modal"]').hidden = true;
}

function updateBioCount() {
  const bio = $('[data-role="ep-bio"]');
  $('[data-role="ep-bio-count"]').textContent = `${bio.value.length}/280`;
}

/* Avatar preview / URL field / remove-button, kept in sync. */
function previewEpAvatar() {
  renderAvatar($('[data-role="ep-avatar"]'), {
    name: $('[data-role="ep-displayName"]').value || state.me?.displayName || "?",
    avatarUrl: $('[data-role="ep-avatarUrl"]').value,
  });
}
function toggleEpRemove() {
  $('[data-role="ep-remove"]').hidden = !$('[data-role="ep-avatarUrl"]').value.trim();
}
function setEpAvatarUrl(url) {
  $('[data-role="ep-avatarUrl"]').value = url;
  previewEpAvatar();
  toggleEpRemove();
}

function setAvatarBusy(busy) {
  $('[data-role="ep-avatar-spinner"]').hidden = !busy;
  $('[data-action="pick-avatar"]').classList.toggle("is-busy", busy);
  $('[data-role="ep-save"]').disabled = busy;
}

async function onAvatarFileChosen(e) {
  const file = e.target.files?.[0];
  e.target.value = ""; // allow re-picking the same file later
  if (!file) return;
  setEpError("");

  if (!file.type.startsWith("image/")) {
    return setEpError("Please choose an image file.");
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return setEpError("Image is too large — pick one under 5 MB.");
  }

  setAvatarBusy(true);
  try {
    const url = await uploadAvatarFile(file);
    setEpAvatarUrl(url);
  } catch (err) {
    setEpError(err?.message ?? "Upload failed. Please try again.");
  } finally {
    setAvatarBusy(false);
  }
}

/**
 * Two-step upload: register the attachment, PUT the bytes to the returned
 * target, then resolve to its public URL (suitable for `avatarUrl`).
 */
async function uploadAvatarFile(file) {
  const created = await api.createUpload({
    kind: "image",
    mimeType: file.type,
    sizeBytes: file.size,
    fileName: file.name,
  });
  if (!created.ok) {
    throw new Error(created.error?.message ?? "Couldn’t start the upload.");
  }

  const { attachment, upload } = created.data;
  const token = getSession()?.token;
  let res;
  try {
    res = await fetch(upload.uploadUrl, {
      method: upload.method || "PUT",
      headers: {
        ...(upload.headers || {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });
  } catch {
    throw new Error("Can’t reach the server to upload.");
  }
  if (!res.ok) throw new Error("Upload failed. Please try again.");

  return attachment.url;
}

function setEpError(msg) {
  const e = $('[data-role="ep-error"]');
  e.textContent = msg;
  e.hidden = !msg;
}

async function saveProfile(e) {
  e.preventDefault();
  setEpError("");
  const me = state.me;

  const displayName = $('[data-role="ep-displayName"]').value.trim();
  const username = $('[data-role="ep-username"]').value.trim();
  const avatarUrl = $('[data-role="ep-avatarUrl"]').value.trim();
  const bio = $('[data-role="ep-bio"]').value.trim();

  // Mirror the server's rules so obvious mistakes surface before the round-trip.
  if (displayName.length < 1) return setEpError("Display name can’t be empty.");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(username)) {
    return setEpError(
      "Username must be 3–20 characters: letters, numbers or underscores, starting with a letter."
    );
  }
  if (avatarUrl && !/^https?:\/\/.+/i.test(avatarUrl)) {
    return setEpError("Avatar URL must start with http:// or https://.");
  }

  // Send only what actually changed.
  const patch = {};
  if (displayName !== (me.displayName ?? "")) patch.displayName = displayName;
  if (username !== (me.username ?? "")) patch.username = username;
  if (avatarUrl !== (me.avatarUrl ?? "")) patch.avatarUrl = avatarUrl || null;
  if (bio !== (me.bio ?? "")) patch.bio = bio || null;

  if (Object.keys(patch).length === 0) {
    closeEditProfile();
    return;
  }

  const saveBtn = $('[data-role="ep-save"]');
  saveBtn.disabled = true;
  const r = await api.updateProfile(patch);
  saveBtn.disabled = false;

  if (!r.ok) {
    return setEpError(r.error?.message ?? "Couldn’t save your profile. Please try again.");
  }

  state.me = { ...state.me, ...r.data };
  persistMe();
  renderMe();
  // A username / name / avatar change can affect what the sidebar shows.
  renderChatList();
  closeEditProfile();
}

/** Keep the persisted session's user in sync with edits. */
function persistMe() {
  const s = getSession();
  if (s) {
    s.user = state.me;
    setSession(s);
  }
}

/* -- Calls ----------------------------------------------------------------- */

/** Look up a user's display info from loaded chats (for incoming-call UI). */
function resolveUser(userId) {
  if (userId === state.me?.id) {
    return { name: "You", avatarUrl: state.me?.avatarUrl ?? null };
  }
  let u = state.activeChat?.members?.find((m) => m.id === userId);
  if (!u) {
    for (const c of state.chats) {
      u = c.members?.find((m) => m.id === userId);
      if (u) break;
    }
  }
  return u
    ? { name: u.displayName, avatarUrl: u.avatarUrl ?? null }
    : { name: "Unknown", avatarUrl: null };
}

/** The other party of the active direct chat, or null (e.g. group chats). */
function getActivePeer() {
  const chat = state.activeChat;
  if (!chat || chat.type !== "direct") return null;
  const other = otherMember(chat);
  if (!other) return null;
  return {
    chatId: chat.id,
    userId: other.id,
    name: other.displayName,
    avatarUrl: other.avatarUrl ?? null,
  };
}

function startCall(media) {
  const peer = getActivePeer();
  if (!peer || !calls) return;
  if (calls.isBusy()) return; // one call at a time in this version
  calls.start(peer, media);
}

/** Title for a chat id, used by the calls layer to label group calls. */
function resolveChat(chatId) {
  const chat =
    state.chats.find((c) => c.id === chatId) ||
    (state.activeChat?.id === chatId ? state.activeChat : null);
  return { title: chat ? chatDisplay(chat).name : "Group call" };
}

function startGroupCall(media) {
  const chat = state.activeChat;
  if (!chat || !calls) return;
  if (chat.type !== "group" && chat.type !== "channel") return;
  if (calls.isBusy()) return; // one call at a time in this version
  calls.startGroup({ chatId: chat.id, title: chatDisplay(chat).name, media });
}

/* -- Features: banner, settings, what's new, presence ---------------------- */

const BANNER_KEY = "relayone.banner.v1.dismissed";
const PRESENCE_KEY = "relayone.presence";

function wireFeatures() {
  // What's-new banner.
  const banner = $('[data-role="feature-banner"]');
  banner.hidden = localStorage.getItem(BANNER_KEY) === "1";
  $('[data-action="dismiss-banner"]').addEventListener("click", () => {
    banner.hidden = true;
    localStorage.setItem(BANNER_KEY, "1");
  });

  $$('[data-action="open-whatsnew"]').forEach((b) => b.addEventListener("click", openWhatsNew));
  $('[data-action="close-whatsnew"]').addEventListener("click", closeWhatsNew);
  $('[data-action="open-settings"]').addEventListener("click", openSettings);
  $('[data-role="push-toggle"]').addEventListener("click", togglePush);
  $('[data-action="clear-cache"]').addEventListener("click", clearCache);
  $('[data-action="revoke-others"]').addEventListener("click", revokeOtherSessions);
  $$('[data-priv]').forEach((b) =>
    b.addEventListener("click", () => setPrivacy(b.dataset.priv, b.dataset.val))
  );
  $('[data-action="close-settings"]').addEventListener("click", closeSettings);

  // Theme controls.
  $$('[data-theme-choice]').forEach((b) =>
    b.addEventListener("click", () => { setTheme(b.dataset.themeChoice); syncThemeUI(); })
  );
  renderAccents();

  // Presence self-status.
  $$('[data-presence-choice]').forEach((b) =>
    b.addEventListener("click", () => { setPresence(b.dataset.presenceChoice); syncPresenceUI(); })
  );
  applyPresenceDot();

  // Profile actions.
  $('[data-action="profile-message"]').addEventListener("click", onProfileMessage);
  $('[data-action="profile-call"]').addEventListener("click", onProfileCall);

  // Backdrop + Esc dismissal for the new modals.
  $('[data-role="settings-modal"]').addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  $('[data-role="whatsnew-modal"]').addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeWhatsNew();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$('[data-role="settings-modal"]').hidden) closeSettings();
    else if (!$('[data-role="whatsnew-modal"]').hidden) closeWhatsNew();
    else if (!$('[data-role="create-chat-modal"]').hidden) closeCreateChat();
    else if (!$('[data-role="fab-menu"]').hidden) closeFab();
  });

  renderWhatsNew();
  wireCreate();
}

function openSettings() {
  syncThemeUI();
  syncPresenceUI();
  syncPrivacyUI();
  void syncPushUI();
  void syncStorageUI();
  void syncSessionsUI();
  $('[data-role="settings-modal"]').hidden = false;
}

/* -- Privacy --------------------------------------------------------------- */

const DEFAULT_PRIVACY = { messages: "everyone", lastSeen: "everyone", avatar: "everyone" };

function syncPrivacyUI() {
  const p = state.me?.privacy || DEFAULT_PRIVACY;
  $$('[data-priv]').forEach((b) => {
    b.classList.toggle("is-active", p[b.dataset.priv] === b.dataset.val);
  });
}

async function setPrivacy(field, val) {
  const current = state.me.privacy || DEFAULT_PRIVACY;
  if (current[field] === val) return;
  const prev = current[field];
  // Optimistic.
  state.me.privacy = { ...current, [field]: val };
  syncPrivacyUI();

  const r = await api.updateProfile({ privacy: { [field]: val } });
  if (r.ok && r.data) {
    state.me = r.data;
    const s = getSession();
    if (s) {
      s.user = r.data;
      setSession(s);
    }
  } else {
    state.me.privacy = { ...state.me.privacy, [field]: prev }; // revert
  }
  syncPrivacyUI();
}

/* -- Storage manager ------------------------------------------------------- */

async function syncStorageUI() {
  const el = $('[data-role="storage-usage"]');
  if (!el) return;
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      el.textContent = quota
        ? `${humanSize(usage)} used of ${humanSize(quota)} available`
        : `${humanSize(usage)} used`;
    } else {
      el.textContent = "Storage info isn’t available in this browser.";
    }
  } catch {
    el.textContent = "Couldn’t read storage usage.";
  }
}

async function clearCache() {
  const el = $('[data-role="storage-usage"]');
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (el) el.textContent = "Cache cleared. Reloading…";
    // Reload so the service worker re-caches a fresh shell.
    setTimeout(() => location.reload(), 600);
  } catch {
    if (el) el.textContent = "Couldn’t clear the cache.";
  }
}

/* -- Security center (sessions) -------------------------------------------- */

async function syncSessionsUI() {
  const listEl = $('[data-role="sessions"]');
  if (!listEl) return;
  clear(listEl);
  listEl.append(el("li", { class: "sessions__loading" }, "Loading…"));
  const r = await api.listSessions();
  clear(listEl);
  if (!r.ok || !r.data?.length) {
    listEl.append(el("li", { class: "sessions__loading" }, "No active sessions."));
    return;
  }
  for (const s of r.data) {
    const meta = s.current
      ? "This device · active now"
      : `Active ${timeRelative(s.lastUsedAt)} · since ${timeRelative(s.createdAt)}`;
    listEl.append(
      el(
        "li",
        { class: "sessions__item" + (s.current ? " is-current" : "") },
        el("span", { class: "sessions__dot" }),
        el(
          "div",
          { class: "sessions__meta" },
          el("span", { class: "sessions__name" }, s.current ? "Current session" : "Other device"),
          el("span", { class: "sessions__sub" }, meta)
        ),
        s.current
          ? el("span", { class: "sessions__badge" }, "This device")
          : el("button", {
              class: "sessions__revoke",
              type: "button",
              onClick: () => revokeSessionById(s.id),
            }, "Sign out")
      )
    );
  }
}

async function revokeSessionById(id) {
  const r = await api.revokeSession(id);
  if (r.ok) syncSessionsUI();
}

async function revokeOtherSessions() {
  const r = await api.revokeOtherSessions();
  if (r.ok) syncSessionsUI();
}

/** Reflect the current push state onto the settings toggle. */
async function syncPushUI() {
  const toggle = $('[data-role="push-toggle"]');
  const sub = $('[data-role="push-sub"]');
  if (!toggle) return;
  const st = await push.status();
  if (!st.supported) {
    toggle.disabled = true;
    toggle.setAttribute("aria-checked", "false");
    sub.textContent = "This browser doesn’t support push notifications.";
    return;
  }
  if (!st.available) {
    toggle.disabled = true;
    toggle.setAttribute("aria-checked", "false");
    sub.textContent = "Push isn’t configured on the server yet.";
    return;
  }
  if (st.permission === "denied") {
    toggle.disabled = true;
    toggle.setAttribute("aria-checked", "false");
    sub.textContent = "Notifications are blocked in your browser settings.";
    return;
  }
  toggle.disabled = false;
  toggle.setAttribute("aria-checked", String(st.subscribed));
  sub.textContent = st.subscribed
    ? "On — you’ll get notified even when RelayOne is closed."
    : "Get notified even when RelayOne is closed.";
}

async function togglePush() {
  const toggle = $('[data-role="push-toggle"]');
  const on = toggle.getAttribute("aria-checked") === "true";
  toggle.disabled = true;
  try {
    if (on) await push.disable();
    else await push.enable();
  } catch (err) {
    $('[data-role="push-sub"]').textContent = err?.message || "Couldn’t change notifications.";
  } finally {
    await syncPushUI();
  }
}
function closeSettings() {
  $('[data-role="settings-modal"]').hidden = true;
}

function syncThemeUI() {
  const pref = getThemePref();
  $$('[data-theme-choice]').forEach((b) =>
    b.classList.toggle("is-active", b.dataset.themeChoice === pref)
  );
  renderAccents();
}
function renderAccents() {
  const wrap = $('[data-role="accents"]');
  if (!wrap) return;
  const current = getAccent();
  clear(wrap);
  for (const [id, a] of Object.entries(ACCENTS)) {
    wrap.append(
      el("button", {
        class: "accent-swatch" + (id === current ? " is-active" : ""),
        type: "button",
        title: a.label,
        "aria-label": a.label,
        style: `background: linear-gradient(135deg, ${a.blue}, ${a.violet});`,
        onClick: () => { setAccent(id); renderAccents(); },
      })
    );
  }
}

/* Presence (self status; real propagation is a backend follow-up). */
function getPresence() {
  return localStorage.getItem(PRESENCE_KEY) || "online";
}
function setPresence(status) {
  localStorage.setItem(PRESENCE_KEY, status);
  applyPresenceDot();
}
function syncPresenceUI() {
  const cur = getPresence();
  $$('[data-presence-choice]').forEach((b) =>
    b.classList.toggle("is-active", b.dataset.presenceChoice === cur)
  );
}
function applyPresenceDot() {
  const av = $('[data-role="me-avatar"]');
  if (!av) return;
  let dot = av.querySelector(".me-presence");
  if (!dot) {
    dot = el("span", { class: "me-presence" });
    av.append(dot);
  }
  dot.className = "me-presence is-" + getPresence();
}

function openWhatsNew() {
  closeSettings();
  $('[data-role="whatsnew-modal"]').hidden = false;
}
function closeWhatsNew() {
  $('[data-role="whatsnew-modal"]').hidden = true;
}
function renderWhatsNew() {
  const list = $('[data-role="whatsnew-list"]');
  if (!list) return;
  clear(list);
  for (const f of ROADMAP) {
    list.append(
      el(
        "li",
        { class: "whatsnew__item" },
        el("span", { class: "whatsnew__icon" }, f.icon),
        el(
          "div",
          { class: "whatsnew__text" },
          el("span", { class: "whatsnew__name" }, f.title),
          el("span", { class: "whatsnew__desc" }, f.desc)
        ),
        el("span", { class: "whatsnew__badge whatsnew__badge--" + f.status },
          f.status === "live" ? "Available" : "Soon")
      )
    );
  }
}

/* Profile action buttons (Message / Call). */
function onProfileMessage() {
  const u = state.viewedProfile;
  closeViewProfile();
  if (!u) return;
  const existing = state.chats.find(
    (c) => c.type === "direct" && c.members?.some((m) => m.id === u.id)
  );
  if (existing) openChat(existing.id);
  else startChatWith(u);
}
function onProfileCall() {
  closeViewProfile();
  startCall("audio");
}

/* -- Create: FAB + group / channel ----------------------------------------- */

let createType = "group";
let lastCreateResults = [];
const createSelected = new Map(); // userId -> user

function wireCreate() {
  $('[data-action="toggle-fab"]').addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFab();
  });
  $('[data-action="create-channel"]').addEventListener("click", () => { closeFab(); openCreateChat("channel"); });
  $('[data-action="create-group"]').addEventListener("click", () => { closeFab(); openCreateChat("group"); });
  $('[data-action="create-direct"]').addEventListener("click", () => { closeFab(); openNewChat(); });
  document.addEventListener("click", (e) => {
    if (!$('[data-role="fab"]').contains(e.target)) closeFab();
  });

  $$('[data-action="close-create-chat"]').forEach((b) => b.addEventListener("click", closeCreateChat));
  $('[data-role="create-chat-modal"]').addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCreateChat();
  });
  $('[data-role="cc-create"]').addEventListener("click", submitCreate);
  wireCreateSearch();
}

function toggleFab() {
  const menu = $('[data-role="fab-menu"]');
  const open = menu.hidden;
  menu.hidden = !open;
  $('[data-role="fab"]').classList.toggle("is-open", open);
}
function closeFab() {
  $('[data-role="fab-menu"]').hidden = true;
  $('[data-role="fab"]').classList.remove("is-open");
}

function openCreateChat(type) {
  createType = type;
  createSelected.clear();
  const isChannel = type === "channel";
  $('[data-role="cc-title"]').textContent = isChannel ? "New channel" : "New group";
  $('[data-role="cc-name-label"]').textContent = isChannel ? "Channel name" : "Group name";
  $('[data-role="cc-name"]').value = "";
  $('[data-role="cc-search"]').value = "";
  clear($('[data-role="cc-results"]'));
  $('[data-role="cc-empty"]').hidden = true;
  ccError("");
  renderCreateSelected();
  $('[data-role="create-chat-modal"]').hidden = false;
  $('[data-role="cc-name"]').focus();
}
function closeCreateChat() {
  $('[data-role="create-chat-modal"]').hidden = true;
}
function ccError(msg) {
  const e = $('[data-role="cc-error"]');
  e.textContent = msg;
  e.hidden = !msg;
}

function wireCreateSearch() {
  const input = $('[data-role="cc-search"]');
  let timer = null;
  let seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      clear($('[data-role="cc-results"]'));
      $('[data-role="cc-empty"]').hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      const reqId = ++seq;
      const r = await api.searchUsers(q);
      if (reqId !== seq) return;
      renderCreateResults(r.ok ? r.data : []);
    }, 300);
  });
}

function renderCreateResults(users) {
  lastCreateResults = users;
  const listEl = $('[data-role="cc-results"]');
  clear(listEl);
  $('[data-role="cc-empty"]').hidden = users.length > 0;
  for (const u of users) {
    const selected = createSelected.has(u.id);
    listEl.append(
      el(
        "li",
        {
          class: "user-result" + (selected ? " is-selected" : ""),
          onClick: () => toggleCreateMember(u),
        },
        withAvatar(el("div", { class: "user-result__avatar" }), { name: u.displayName, avatarUrl: u.avatarUrl }),
        el(
          "div",
          { class: "user-result__meta" },
          el("span", { class: "user-result__name" }, u.displayName),
          el("span", { class: "user-result__handle" }, `@${u.username}`)
        ),
        el("span", { class: "user-result__check" }, selected ? "✓" : "")
      )
    );
  }
}

function toggleCreateMember(user) {
  if (createSelected.has(user.id)) createSelected.delete(user.id);
  else createSelected.set(user.id, user);
  renderCreateSelected();
  renderCreateResults(lastCreateResults); // refresh the ✓ marks
}

function renderCreateSelected() {
  const wrap = $('[data-role="cc-selected"]');
  clear(wrap);
  wrap.hidden = createSelected.size === 0;
  for (const u of createSelected.values()) {
    wrap.append(
      el(
        "span",
        { class: "cc-chip" },
        el("span", {}, u.displayName),
        el("button", { class: "cc-chip__x", type: "button", "aria-label": "Remove",
          onClick: () => { createSelected.delete(u.id); renderCreateSelected(); } }, "✕")
      )
    );
  }
}

async function submitCreate() {
  const name = $('[data-role="cc-name"]').value.trim();
  if (!name) return ccError(createType === "channel" ? "Please name your channel." : "Please name your group.");
  ccError("");

  const btn = $('[data-role="cc-create"]');
  btn.disabled = true;
  const r = await api.createChat({
    type: createType,
    title: name,
    memberIds: [...createSelected.keys()],
  });
  btn.disabled = false;

  if (!r.ok) return ccError(r.error?.message ?? "Couldn’t create. Please try again.");
  closeCreateChat();
  await loadChats();
  openChat(r.data.id);
}

/* -- New chat -------------------------------------------------------------- */

function openNewChat() {
  $('[data-role="new-chat-modal"]').hidden = false;
  const input = $('[data-role="user-search"]');
  input.value = "";
  clear($('[data-role="user-results"]'));
  $('[data-role="search-empty"]').hidden = true;
  input.focus();
}
function closeNewChat() {
  $('[data-role="new-chat-modal"]').hidden = true;
}

function wireNewChatSearch() {
  const input = $('[data-role="user-search"]');
  let timer = null;
  let seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      clear($('[data-role="user-results"]'));
      $('[data-role="search-empty"]').hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      const reqId = ++seq;
      const r = await api.searchUsers(q);
      if (reqId !== seq) return;
      renderUserResults(r.ok ? r.data : []);
    }, 300);
  });
  $('[data-role="new-chat-modal"]').addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeNewChat();
  });
}

function renderUserResults(users) {
  const listEl = $('[data-role="user-results"]');
  clear(listEl);
  $('[data-role="search-empty"]').hidden = users.length > 0;
  for (const u of users) {
    listEl.append(
      el(
        "li",
        { class: "user-result", onClick: () => startChatWith(u) },
        withAvatar(el("div", { class: "user-result__avatar" }), {
          name: u.displayName,
          avatarUrl: u.avatarUrl,
        }),
        el(
          "div",
          { class: "user-result__meta" },
          el("span", { class: "user-result__name" }, u.displayName),
          el("span", { class: "user-result__handle" }, `@${u.username}`)
        )
      )
    );
  }
}

async function startChatWith(user) {
  const r = await api.createDirect(user.id);
  closeNewChat();
  if (!r.ok) {
    if (r.status === 403) {
      window.alert(r.error?.message || "You can’t start a chat with this person.");
    }
    return;
  }
  const chatId = r.data.id;
  // Refresh list (dedupe means this may be an existing chat) then open.
  await loadChats();
  openChat(chatId);
}

/* -- Read state ------------------------------------------------------------ */

function markReadLatest() {
  const last = state.messages[state.messages.length - 1];
  if (!last || !state.activeId) return;
  // Persist + broadcast the read receipt.
  if (rt?.isOpen()) rt.send({ type: "read", chatId: state.activeId, messageId: last.id });
  else api.markRead(state.activeId, last.id);
  // Locally clear unread for this chat.
  const chat = state.chats.find((c) => c.id === state.activeId);
  if (chat && chat.unreadCount) {
    chat.unreadCount = 0;
    renderChatList();
  }
}

/* -- Realtime handling ----------------------------------------------------- */

function setConnStatus(status) {
  const banner = $('[data-role="conn-banner"]');
  if (status === "online") {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    banner.textContent =
      status === "reconnecting" || status === "connecting"
        ? "Reconnecting…"
        : "Connection lost";
    banner.className = "conn-banner" + (status === "offline" ? " is-lost" : "");
  }
}

function handleRealtime(ev) {
  if (typeof ev.type === "string" && ev.type.startsWith("call.")) {
    return calls?.handleEvent(ev);
  }
  switch (ev.type) {
    case "message.new":
      return onNewMessage(ev.message);
    case "message.edited":
      return onEditedMessage(ev.message);
    case "message.deleted":
      return onDeletedMessage(ev.chatId, ev.messageId);
    case "message.pin":
      return onMessagePin(ev);
    case "message.reaction":
      return onReaction(ev);
    case "typing":
      return onTyping(ev);
    case "presence":
      return onPresence(ev);
    case "read":
      return onRead(ev);
    case "notification":
      return; // list refresh is driven by message.new
    default:
      return;
  }
}

function isNearBottom(msgEl) {
  return msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 120;
}
function scrollToBottom() {
  const msgEl = $('[data-role="messages"]');
  msgEl.scrollTop = msgEl.scrollHeight;
}

/** Scroll to a message (if it's currently loaded) and briefly highlight it. */
function jumpToMessage(id) {
  const node = state.msgNodes.get(id);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.remove("is-highlighted");
  // reflow so the animation can retrigger
  void node.offsetWidth;
  node.classList.add("is-highlighted");
  setTimeout(() => node.classList.remove("is-highlighted"), 1600);
}

/* -- Saved Messages -------------------------------------------------------- */

async function openSaved() {
  const r = await api.getSaved();
  if (!r.ok) return;
  await loadChats(); // make sure the saved chat is in state (members, etc.)
  openChat(r.data.id);
}

/* -- Pinned messages ------------------------------------------------------- */

async function loadPins(chatId) {
  const r = await api.listPins(chatId);
  if (state.activeId !== chatId) return; // user switched chats meanwhile
  state.pins = r.ok ? r.data : [];
  if (state.pinIdx >= state.pins.length) state.pinIdx = 0;
  renderPinned();
}

function resetPinnedUI() {
  $('[data-role="pinned"]').hidden = true;
  $('[data-role="pinned-panel"]').hidden = true;
}

function renderPinned() {
  const wrap = $('[data-role="pinned"]');
  if (!state.pins.length) {
    wrap.hidden = true;
    $('[data-role="pinned-panel"]').hidden = true;
    return;
  }
  wrap.hidden = false;
  const idx = Math.min(state.pinIdx, state.pins.length - 1);
  const cur = state.pins[idx];
  $('[data-role="pinned-title"]').textContent =
    state.pins.length > 1 ? `Pinned ${idx + 1} / ${state.pins.length}` : "Pinned message";
  $('[data-role="pinned-text"]').textContent = pinPreviewText(cur);
  renderPinnedPanel();
}

function pinPreviewText(m) {
  if (!m) return "";
  if (m.deletedAt) return "Message unavailable";
  if (m.content) return m.content;
  if (m.attachments?.length) return "Attachment";
  return "Message";
}

function renderPinnedPanel() {
  const list = $('[data-role="pinned-list"]');
  $('[data-role="pinned-count"]').textContent = `Pinned messages · ${state.pins.length}`;
  clear(list);
  for (const m of state.pins) {
    list.append(
      el(
        "li",
        { class: "pinned-item" },
        el(
          "button",
          {
            class: "pinned-item__main",
            type: "button",
            onClick: () => { jumpToMessage(m.id); $('[data-role="pinned-panel"]').hidden = true; },
          },
          el("span", { class: "pinned-item__who" }, senderName(m.senderId)),
          el("span", { class: "pinned-item__text" }, pinPreviewText(m))
        ),
        el(
          "button",
          { class: "pinned-item__unpin", type: "button", title: "Unpin",
            onClick: (e) => { e.stopPropagation(); togglePin(m); } },
          "✕"
        )
      )
    );
  }
}

function jumpNextPin() {
  if (!state.pins.length) return;
  const idx = Math.min(state.pinIdx, state.pins.length - 1);
  jumpToMessage(state.pins[idx].id);
  state.pinIdx = (idx + 1) % state.pins.length;
  renderPinned();
}

function togglePinsPanel() {
  const panel = $('[data-role="pinned-panel"]');
  panel.hidden = !panel.hidden;
}

async function togglePin(m) {
  const willPin = !m.pinnedAt;
  const r = willPin ? await api.pinMessage(m.id) : await api.unpinMessage(m.id);
  if (!r.ok) return;
  applyPin(m.id, r.data?.pinnedAt ?? null);
}

/** Apply a pin state change (from our action or a realtime event). */
function applyPin(messageId, pinnedAt) {
  const msg = state.messages.find((x) => x.id === messageId);
  if (msg) {
    msg.pinnedAt = pinnedAt;
    replaceMessageNode(msg);
  }
  if (state.activeId) loadPins(state.activeId);
}

function onMessagePin(ev) {
  if (ev.chatId !== state.activeId) return;
  applyPin(ev.messageId, ev.pinnedAt);
}

/* -- Link previews --------------------------------------------------------- */

function firstUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[),.;:!?]+$/, "") : null;
}

function cssUrlEscape(u) {
  return encodeURI(u).replace(/["'()\\]/g, (c) => "%" + c.charCodeAt(0).toString(16));
}

async function attachLinkPreview(card, url) {
  let preview = linkCache.get(url);
  if (preview === undefined) {
    const r = await api.linkPreview(url);
    preview = r.ok ? r.data : null;
    linkCache.set(url, preview);
  }
  if (!card.isConnected) return; // node was replaced/removed
  card.classList.remove("is-loading");
  clear(card);

  const host = hostnameOf(url);
  const rich = preview && (preview.title || preview.image);

  if (rich && preview.image) {
    card.append(
      el("span", { class: "msg__link-img", style: `background-image:url("${cssUrlEscape(preview.image)}")` })
    );
  } else if (!rich) {
    // Minimal fallback so every link still gets a "preview" card.
    card.classList.add("msg__link-card--min");
    card.append(el("span", { class: "msg__link-glyph" }, "🔗"));
  }

  const body = el("span", { class: "msg__link-body" });
  body.append(el("span", { class: "msg__link-site" }, (preview && preview.siteName) || host));
  body.append(el("span", { class: "msg__link-title" }, (preview && preview.title) || host));
  if (preview && preview.description) {
    body.append(el("span", { class: "msg__link-desc" }, preview.description));
  } else if (!rich) {
    body.append(el("span", { class: "msg__link-desc" }, url.replace(/^https?:\/\//, "")));
  }
  card.append(body);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* -- Attachment rendering -------------------------------------------------- */

function humanSize(n) {
  if (typeof n !== "number") return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fileGlyph(a) {
  const name = (a.fileName || "").toLowerCase();
  const mt = a.mimeType || "";
  if (mt.includes("pdf") || name.endsWith(".pdf")) return "📕";
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return "🗜️";
  if (/\.(docx?|odt|rtf)$/.test(name)) return "📘";
  if (/\.(xlsx?|csv|ods)$/.test(name)) return "📊";
  if (/\.(html?|css|js|ts|json|xml|md|txt)$/.test(name) || mt.startsWith("text/")) return "📄";
  return "📎";
}

/** All image attachments in the loaded messages, in order — the lightbox gallery. */
function collectImageGallery() {
  const imgs = [];
  for (const m of state.messages) {
    if (m.deletedAt) continue;
    for (const att of m.attachments || []) {
      if (att.kind === "image" && att.url) imgs.push(att);
    }
  }
  return imgs;
}

function openImageViewer(a) {
  const gallery = collectImageGallery();
  const idx = gallery.findIndex((x) => (x.id && a.id && x.id === a.id) || x.url === a.url);
  viewer.openImages(gallery.length ? gallery : [a], idx >= 0 ? idx : 0);
}

function attachmentNode(a) {
  if (a.kind === "image") {
    return el(
      "a",
      {
        class: "msg__image-link",
        href: a.url,
        rel: "noopener",
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openImageViewer(a);
        },
      },
      el("img", { class: "msg__image", src: a.url, alt: a.fileName || "image", loading: "lazy" })
    );
  }
  if (a.kind === "video") {
    return el("video", { class: "msg__video", src: a.url, controls: true, preload: "metadata" });
  }
  if (a.kind === "voice") {
    return el("audio", { class: "msg__audio", src: a.url, controls: true, preload: "metadata" });
  }
  // Documents & everything else → a file card that opens an in-app preview.
  return el(
    "a",
    {
      class: "msg__file",
      href: a.url,
      rel: "noopener",
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        viewer.openFile(a);
      },
    },
    el("span", { class: "msg__file-icon" }, fileGlyph(a)),
    el(
      "span",
      { class: "msg__file-meta" },
      el("span", { class: "msg__file-name" }, a.fileName || a.kind),
      el("span", { class: "msg__file-size" }, humanSize(a.sizeBytes))
    ),
    el("span", { class: "msg__file-dl" }, "⭳")
  );
}

function onNewMessage(message) {
  // Update the chat-list summary.
  const chat = state.chats.find((c) => c.id === message.chatId);
  if (chat) {
    chat.lastMessage = {
      id: message.id,
      senderId: message.senderId,
      content: message.content,
      createdAt: message.createdAt,
      deletedAt: message.deletedAt,
    };
    chat.updatedAt = message.createdAt;
    if (message.chatId !== state.activeId && message.senderId !== state.me.id) {
      chat.unreadCount = (chat.unreadCount ?? 0) + 1;
    }
    // Move to top.
    state.chats = [chat, ...state.chats.filter((c) => c.id !== chat.id)];
  } else {
    // A chat we didn't have yet (e.g. someone started a chat with us).
    loadChats();
  }
  renderChatList();

  if (message.chatId === state.activeId) {
    if (state.messages.some((m) => m.id === message.id)) return; // dedupe
    const msgEl = $('[data-role="messages"]');
    const near = isNearBottom(msgEl);
    state.messages.push(message);
    const node = messageNode(message);
    state.msgNodes.set(message.id, node);
    msgEl.append(node);
    if (near || message.senderId === state.me.id) scrollToBottom();
    refreshReceipts();
    if (message.senderId !== state.me.id && near) markReadLatest();
  }
}

function onEditedMessage(message) {
  if (message.chatId !== state.activeId) return;
  const idx = state.messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) state.messages[idx] = message;
  replaceMessageNode(message);
  refreshReceipts();
}

function onDeletedMessage(chatId, messageId) {
  if (chatId !== state.activeId) return;
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx >= 0) {
    state.messages[idx] = { ...state.messages[idx], deletedAt: new Date().toISOString(), content: null };
    replaceMessageNode(state.messages[idx]);
  }
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat?.lastMessage?.id === messageId) {
    chat.lastMessage.deletedAt = new Date().toISOString();
    renderChatList();
  }
  if (chatId === state.activeId && state.pins.some((p) => p.id === messageId)) {
    loadPins(chatId);
  }
}

function onReaction(ev) {
  if (ev.chatId !== state.activeId) return;
  const msg = state.messages.find((m) => m.id === ev.messageId);
  if (!msg) return;
  msg.reactions = msg.reactions ?? [];
  if (ev.op === "add") {
    if (!msg.reactions.some((r) => r.emoji === ev.emoji && r.userId === ev.userId)) {
      msg.reactions.push({ emoji: ev.emoji, userId: ev.userId });
    }
  } else {
    msg.reactions = msg.reactions.filter((r) => !(r.emoji === ev.emoji && r.userId === ev.userId));
  }
  replaceMessageNode(msg);
}

function onTyping(ev) {
  if (ev.chatId !== state.activeId || ev.userId === state.me.id) return;
  clearTimeout(state.typingTimers.get(ev.userId));
  if (ev.isTyping) {
    state.typingTimers.set(
      ev.userId,
      setTimeout(() => {
        state.typingTimers.delete(ev.userId);
        renderHeaderStatus();
      }, 4000)
    );
  } else {
    state.typingTimers.delete(ev.userId);
  }
  renderHeaderStatus();
}

function onPresence(ev) {
  state.presence.set(ev.userId, ev.online);
  renderChatList();
  if (state.activeChat) {
    renderHeaderStatus();
    refreshReceipts();
  }
}

function onRead(ev) {
  if (ev.chatId !== state.activeId || !state.activeChat) return;
  const st = state.activeChat.memberStates.find((s) => s.userId === ev.userId);
  if (st) {
    st.lastReadMessageId = ev.lastReadMessageId;
    st.lastReadAt = ev.at;
  }
  refreshReceipts();
}
