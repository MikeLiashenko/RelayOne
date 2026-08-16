/**
 * RelayOne Spaces — communities UI.
 *
 * A Space is a place, not a Discord server: opening one lands on **Home**
 * (welcome, members/online, latest announcement, a way in), with a left rail of
 * grouped, typed channels and a members view. Text/forum/poll channels hand off
 * to the app's chat view; voice/video channels start a call. All DOM is built
 * with `el()` and user content goes through textContent — never innerHTML.
 */
import { clear, el, initials, avatarHue } from "../dom.js";

const RANK = { owner: 4, admin: 3, moderator: 2, contributor: 1, member: 0 };
const ROLE_LABEL = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator",
  contributor: "Contributor",
  member: "Member",
};
const KIND_ICON = {
  text: "#",
  forum: "🧵",
  announcement: "📢",
  poll: "📊",
  voice: "🔊",
  video: "🎥",
};
const KIND_LABEL = {
  text: "💬 Text",
  forum: "🧵 Forum",
  announcement: "📢 Announcement",
  poll: "📊 Poll",
  voice: "🔊 Voice",
  video: "🎥 Video",
};
const SECTION_ORDER = ["Overview", "Channels", "Voice"];
const isCall = (kind) => kind === "voice" || kind === "video";

const PERMISSIONS = [
  ["manage_space", "Manage Space", "Edit name, handle, description, avatar & banner"],
  ["manage_channels", "Manage channels", "Create and delete channels"],
  ["manage_roles", "Manage roles", "Create, edit and assign custom roles"],
  ["manage_members", "Manage members", "Change ladder roles and remove members"],
  ["post_announcements", "Post announcements", "Post in announcement channels"],
];
const ROLE_COLORS = ["#5b6bff", "#7a8cff", "#46d39a", "#f7b955", "#f2732e", "#ff5c78", "#a06bff", "#2bb8c9"];

export function createSpaces({ api, getMe, openChannel, startChannelCall }) {
  let root = null;
  let view = "list"; // "list" | "space" | "forum" | "post" | "roles"
  let mainView = "home"; // within a space: "home" | "members"
  let spaces = [];
  let current = null; // SpaceDetail
  let forumChannel = null; // the forum channel being browsed
  let busy = false;

  function mount() {
    if (root) return;
    root = el("div", { class: "spaces-overlay", "data-role": "spaces-overlay", hidden: true });
    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });
    document.body.append(root);
  }

  function close() {
    if (root) root.hidden = true;
  }

  async function open() {
    mount();
    root.hidden = false;
    view = "list";
    await loadList();
  }

  /** Re-show a Space (used by the chat "back" button). */
  async function reopenSpace(spaceId) {
    mount();
    root.hidden = false;
    mainView = "home";
    await openSpace(spaceId);
  }

  async function loadList() {
    renderLoading("Loading your Spaces…");
    const res = await api.listSpaces();
    spaces = res.ok ? res.data : [];
    if (view === "list") renderList();
  }

  async function openSpace(spaceId) {
    view = "space";
    renderLoading("Opening Space…");
    const res = await api.getSpace(spaceId);
    if (!res.ok) {
      view = "list";
      await loadList();
      return;
    }
    current = res.data;
    if (view === "space") renderSpace();
  }

  /** Realtime: a Space changed — refresh whatever is on screen. */
  async function onSpaceUpdated(spaceId) {
    if (!root || root.hidden) return;
    if (current?.id === spaceId && ["space", "forum", "post", "roles"].includes(view)) {
      const res = await api.getSpace(spaceId);
      if (!res.ok) {
        current = null;
        view = "list";
        await loadList();
        return;
      }
      current = res.data;
      // Only the workspace / roles views re-render live; forum & post views keep
      // their place (their member/author lookups just use the refreshed data).
      if (view === "space") renderSpace();
      else if (view === "roles") renderRoles();
    } else if (view === "list") {
      await loadList();
    }
  }

  /* -- Shell --------------------------------------------------------------- */

  function shell(opts, ...body) {
    clear(root);
    const head = el("header", { class: "spaces-card__head" });
    if (opts.onBack) {
      head.append(
        el(
          "button",
          { class: "icon-btn spaces-card__back", type: "button", "aria-label": "Back", title: "Back", onClick: opts.onBack },
          backIcon()
        )
      );
    }
    head.append(el("h2", { class: "spaces-card__title", text: opts.title }));
    if (opts.action) head.append(opts.action);
    head.append(
      el("button", { class: "icon-btn", type: "button", "aria-label": "Close", title: "Close", onClick: close }, closeIcon())
    );

    const card = el("div", { class: "spaces-card" + (opts.wide ? " spaces-card--wide" : "") }, head, ...body);
    root.append(card);
    return card;
  }

  function renderLoading(msg) {
    shell({ title: "🌐 Spaces" }, el("div", { class: "spaces-loading" }, el("span", { class: "spinner" }), msg));
  }

  /* -- Space list ---------------------------------------------------------- */

  function renderList() {
    const body = el("div", { class: "spaces-list" });

    if (spaces.length === 0) {
      body.append(
        el(
          "div",
          { class: "spaces-empty" },
          el("div", { class: "spaces-empty__glyph", text: "🌐" }),
          el("h3", { text: "Your Spaces live here" }),
          el("p", { class: "spaces-empty__sub", text: "Create a community with channels, roles and a home — or join one with its @handle." })
        )
      );
    } else {
      for (const s of spaces) {
        body.append(
          el(
            "button",
            { class: "space-card", type: "button", onClick: () => openSpace(s.id) },
            spaceAvatar(s, "md"),
            el(
              "span",
              { class: "space-card__meta" },
              el("span", { class: "space-card__name", text: s.name }),
              el("span", { class: "space-card__handle", text: s.handle ? "@" + s.handle : "" }),
              el(
                "span",
                { class: "space-card__stats" },
                el("span", { text: `${fmt(s.memberCount)} member${s.memberCount === 1 ? "" : "s"}` }),
                s.onlineCount ? el("span", { class: "space-card__online", text: `${fmt(s.onlineCount)} online` }) : null
              )
            ),
            roleBadge(s.myRole)
          )
        );
      }
    }

    const actions = el(
      "div",
      { class: "spaces-actions" },
      el("button", { class: "btn btn--primary", type: "button", onClick: showCreateForm }, "＋ New Space"),
      el("button", { class: "btn btn--ghost", type: "button", onClick: showJoinForm }, "Join by handle")
    );

    shell({ title: "🌐 Spaces" }, body, actions);
  }

  /* -- Space workspace (nav + main) ---------------------------------------- */

  function renderSpace() {
    const s = current;

    /* Left rail. */
    const nav = el("div", { class: "space-nav" });
    nav.append(
      el(
        "div",
        { class: "space-nav__id" },
        spaceAvatar(s, "sm"),
        el(
          "div",
          { class: "space-nav__idmeta" },
          el("div", { class: "space-nav__name", text: s.name }),
          el("div", { class: "space-nav__handle", text: s.handle ? "@" + s.handle : "" })
        ),
        can("manage_space")
          ? el(
              "button",
              { class: "icon-btn space-nav__gear", type: "button", title: "Space settings", "aria-label": "Space settings", onClick: showEditForm },
              gearIcon()
            )
          : null
      )
    );

    // Home + Members are virtual nav items; channels are grouped by section.
    nav.append(navItem("🏠", "Home", mainView === "home", () => selectMain("home")));

    const bySection = new Map();
    for (const c of s.channels) {
      const arr = bySection.get(c.category) || [];
      arr.push(c);
      bySection.set(c.category, arr);
    }
    const sections = [...bySection.keys()].sort(
      (a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b)
    );
    for (const section of sections) {
      nav.append(el("div", { class: "space-nav__section", text: section }));
      for (const c of bySection.get(section)) {
        nav.append(
          navItem(
            c.icon || KIND_ICON[c.kind] || "#",
            c.name,
            false,
            () => openChannelEntry(c),
            can("manage_channels") && s.channels.length > 1 ? () => deleteChannel(c) : null
          )
        );
      }
    }
    if (can("manage_channels")) {
      nav.append(navItem("＋", "Add channel", false, () => showChannelForm(), null, "space-nav__item--add"));
    }

    nav.append(el("div", { class: "space-nav__section", text: "Community" }));
    nav.append(navItem("👥", `Members · ${fmt(s.memberCount)}`, mainView === "members", () => selectMain("members")));
    if (can("manage_roles")) {
      nav.append(navItem("🎭", `Roles · ${fmt(s.roles.length)}`, false, () => openRoles()));
    }

    /* Main pane. */
    const main = el("div", { class: "space-main", "data-role": "space-main" });

    const card = shell({ title: "", wide: true, onBack: () => backToList() }, el("div", { class: "space-workspace" }, nav, main));
    // Replace the empty title with the Space name for context.
    card.querySelector(".spaces-card__title").textContent = "🌐 " + s.name;

    fillMain(main);
  }

  function selectMain(v) {
    mainView = v;
    renderSpace(); // rebuilds nav (active states) + main from mainView
  }

  function fillMain(main) {
    clear(main);
    if (mainView === "members") main.append(renderMembers());
    else main.append(renderHome());
  }

  /** Does the caller hold a permission in the current Space? */
  function can(perm) {
    return (current?.myPermissions || []).includes(perm);
  }
  function roleById() {
    const m = new Map();
    for (const r of current?.roles || []) m.set(r.id, r);
    return m;
  }

  /** Route a channel click by its type: forum → forum view, voice → call, else chat. */
  function openChannelEntry(c) {
    if (c.kind === "forum") return openForum(c);
    if (isCall(c.kind)) return startChannelCall(c.chatId, current.id, c.kind === "video" ? "video" : "audio");
    return openChannel(c.chatId, current.id);
  }

  /* -- Home ---------------------------------------------------------------- */

  function renderHome() {
    const s = current;
    const home = el("div", { class: "space-home" });

    // Banner + identity.
    const banner = el("div", { class: "space-home__banner" });
    if (s.bannerUrl) banner.setAttribute("style", `background-image:url("${cssUrl(s.bannerUrl)}")`);
    home.append(
      el(
        "div",
        { class: "space-home__hero" },
        banner,
        el(
          "div",
          { class: "space-home__herometa" },
          spaceAvatar(s, "lg"),
          el("h1", { class: "space-home__name", text: s.name }),
          el("div", { class: "space-home__handle", text: s.handle ? "@" + s.handle : "" })
        )
      )
    );

    home.append(el("p", { class: "space-home__welcome", text: s.description || "Welcome to the Space." }));

    // Stat chips.
    home.append(
      el(
        "div",
        { class: "space-home__stats" },
        statChip(fmt(s.memberCount), s.memberCount === 1 ? "member" : "members"),
        statChip(fmt(s.onlineCount), "online", true),
        statChip(String(s.channels.length), "channels")
      )
    );

    // Latest announcement card.
    if (s.latestAnnouncement) {
      const a = s.latestAnnouncement;
      home.append(
        el(
          "button",
          {
            class: "space-home__card space-home__announce",
            type: "button",
            onClick: () => openChannel(a.chatId, s.id),
          },
          el("div", { class: "space-home__card-icon", text: "📢" }),
          el(
            "div",
            { class: "space-home__card-body" },
            el("div", { class: "space-home__card-title", text: "Latest announcement" }),
            el("div", { class: "space-home__card-text", text: preview(a.content) || "New announcement" }),
            el("div", { class: "space-home__card-sub", text: `${a.senderName} · ${timeAgo(a.createdAt)}` })
          )
        )
      );
    }

    // Quick tiles for the notable channels.
    const tiles = el("div", { class: "space-home__tiles" });
    const forum = s.channels.find((c) => c.kind === "forum");
    const polls = s.channels.find((c) => c.kind === "poll");
    const voice = s.channels.find((c) => isCall(c.kind));
    if (forum) tiles.append(homeTile("🧵", forum.name, "Discussions & posts", () => openForum(forum)));
    if (polls) tiles.append(homeTile("📊", polls.name, "Vote & see results", () => openChannel(polls.chatId, s.id)));
    if (voice)
      tiles.append(
        homeTile("🔊", voice.name, "Jump into voice", () =>
          startChannelCall(voice.chatId, s.id, voice.kind === "video" ? "video" : "audio")
        )
      );
    if (tiles.childElementCount) home.append(tiles);

    // Primary way in.
    const entry = s.channels.find((c) => c.kind === "forum") || s.channels.find((c) => c.kind === "text");
    if (entry) {
      home.append(
        el(
          "button",
          { class: "btn btn--primary space-home__cta", type: "button", onClick: () => openChannelEntry(entry) },
          "Join the discussion"
        )
      );
    }

    return home;
  }

  /* -- Members ------------------------------------------------------------- */

  function renderMembers() {
    const s = current;
    const meId = getMe()?.id;
    const myRank = RANK[s.myRole] ?? 0;
    const roles = roleById();
    const wrap = el("div", { class: "space-members" });
    wrap.append(el("h3", { class: "space-main__title", text: `Members · ${fmt(s.memberCount)}` }));

    for (const m of s.members) {
      const canManage = m.user.id !== meId && myRank > (RANK[m.role] ?? 0) && can("manage_members");
      const badges = el("span", { class: "member-row__badges" }, roleBadge(m.role));
      for (const rid of m.customRoleIds || []) {
        const r = roles.get(rid);
        if (r) badges.append(customRoleChip(r));
      }
      const row = el(
        "div",
        { class: "member-row" },
        memberAvatar(m.user),
        el(
          "span",
          { class: "member-row__meta" },
          el("span", { class: "member-row__name", text: m.user.displayName }),
          el("span", { class: "member-row__handle", text: `@${m.user.username}` })
        ),
        badges
      );
      if (canManage || (can("manage_roles") && m.user.id !== meId)) row.append(memberMenu(m, canManage));
      wrap.append(row);
    }

    // Leave / delete lives with the members view.
    const footer = el("div", { class: "space-detail__actions" });
    if (s.myRole === "owner") {
      footer.append(
        el(
          "button",
          {
            class: "btn btn--danger",
            type: "button",
            onClick: async () => {
              if (!confirm(`Delete “${s.name}” for everyone? This can’t be undone.`)) return;
              const res = await api.deleteSpace(s.id);
              if (res.ok) backToList();
            },
          },
          "Delete Space"
        )
      );
    } else {
      footer.append(
        el(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onClick: async () => {
              if (!confirm(`Leave “${s.name}”?`)) return;
              const res = await api.leaveSpace(s.id);
              if (res.ok) backToList();
            },
          },
          "Leave Space"
        )
      );
    }
    wrap.append(footer);
    return wrap;
  }

  function memberMenu(m, canManage) {
    const s = current;
    const wrap = el("div", { class: "member-row__manage" });

    if (canManage) {
      const canMakeAdmin = s.myRole === "owner" && m.role !== "admin";
      const opts = [];
      if (canMakeAdmin) opts.push(["admin", "Admin"]);
      if (m.role !== "moderator") opts.push(["moderator", "Moderator"]);
      if (m.role !== "contributor") opts.push(["contributor", "Contributor"]);
      if (m.role !== "member") opts.push(["member", "Member"]);
      for (const [role, label] of opts) {
        wrap.append(
          el(
            "button",
            {
              class: "member-row__act",
              type: "button",
              onClick: async () => {
                const res = await api.setSpaceMemberRole(s.id, m.user.id, role);
                if (res.ok) openSpace(s.id);
              },
            },
            label
          )
        );
      }
    }

    // Custom-role toggles (needs manage_roles).
    if (can("manage_roles")) {
      const held = new Set(m.customRoleIds || []);
      for (const r of s.roles) {
        const on = held.has(r.id);
        wrap.append(
          el(
            "button",
            {
              class: "member-row__act member-row__act--role" + (on ? " is-on" : ""),
              type: "button",
              style: on && r.color ? `border-color:${r.color};color:${r.color}` : null,
              onClick: async () => {
                const res = on
                  ? await api.unassignSpaceRole(s.id, m.user.id, r.id)
                  : await api.assignSpaceRole(s.id, m.user.id, r.id);
                if (res.ok) openSpace(s.id);
              },
            },
            (on ? "✓ " : "+ ") + r.name
          )
        );
      }
    }

    if (canManage) {
      wrap.append(
        el(
          "button",
          {
            class: "member-row__act member-row__act--danger",
            type: "button",
            onClick: async () => {
              if (!confirm(`Remove ${m.user.displayName} from the Space?`)) return;
              const res = await api.kickSpaceMember(s.id, m.user.id);
              if (res.ok) openSpace(s.id);
            },
          },
          "Remove"
        )
      );
    }
    return wrap;
  }

  function customRoleChip(r) {
    const style = r.color ? `background:${hexToRgba(r.color, 0.18)};color:${r.color}` : null;
    return el("span", { class: "role-chip", style, text: r.name });
  }

  async function deleteChannel(c) {
    if (!confirm(`Delete #${c.name}? Its messages are removed.`)) return;
    const res = await api.deleteSpaceChannel(c.id);
    if (res.ok) openSpace(current.id);
  }

  /* -- Forum --------------------------------------------------------------- */

  async function openForum(channel) {
    view = "forum";
    forumChannel = channel;
    renderLoading(`Loading ${channel.name}…`);
    const res = await api.listForum(channel.chatId);
    if (!res.ok) return openSpace(current.id);
    if (view === "forum") renderForum(res.data);
  }

  function renderForum(topics) {
    const ch = forumChannel;
    const members = memberMap();

    const list = el("div", { class: "forum-list" });
    if (!topics.length) {
      list.append(
        el(
          "div",
          { class: "spaces-empty" },
          el("div", { class: "spaces-empty__glyph", text: "🧵" }),
          el("h3", { text: "No posts yet" }),
          el("p", { class: "spaces-empty__sub", text: "Start the first discussion in this forum." })
        )
      );
    }
    for (const t of topics) {
      const { title, body } = splitTopic(t.content);
      const author = members.get(t.senderId);
      list.append(
        el(
          "button",
          { class: "forum-topic", type: "button", onClick: () => openPost(ch, t.id) },
          el(
            "div",
            { class: "forum-topic__body" },
            el("div", { class: "forum-topic__title", text: title || "(untitled)" }),
            body ? el("div", { class: "forum-topic__preview", text: preview(body) }) : null,
            el(
              "div",
              { class: "forum-topic__meta" },
              el("span", { text: author ? author.displayName : "Member" }),
              el("span", { class: "forum-topic__dot", text: "·" }),
              el("span", { text: `${t.replyCount} repl${t.replyCount === 1 ? "y" : "ies"}` }),
              el("span", { class: "forum-topic__dot", text: "·" }),
              el("span", { text: timeAgo(t.lastActivityAt) })
            )
          ),
          el("span", { class: "forum-topic__count", text: String(t.replyCount) })
        )
      );
    }

    const newBtn = el(
      "button",
      { class: "btn btn--primary forum__new", type: "button", onClick: () => showPostForm(ch) },
      "＋ New post"
    );
    shell({ title: `🧵 ${ch.name}`, onBack: () => openSpace(current.id), action: null }, newBtn, list);
  }

  function showPostForm(ch) {
    const title = textField("Post title", "120");
    const bodyInput = el("textarea", {
      class: "field__input field__textarea",
      rows: "5",
      maxlength: "8000",
      placeholder: "Write your post…",
    });
    const errBox = el("div", { class: "composer-error", hidden: true });
    const submit = async () => {
      const t = title.input.value.trim();
      if (!t) return showErr(errBox, "Give your post a title.");
      if (busy) return;
      const body = bodyInput.value.trim();
      const content = body ? `${t}\n\n${body}` : t;
      busy = true;
      const res = await api.sendMessage(ch.chatId, { content });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t post.");
      openForum(ch);
    };
    formShell(`🧵 New post`, () => openForum(ch), [
      title.wrap,
      el("label", { class: "field" }, el("span", { class: "field__label", text: "Body" }), bodyInput),
      errBox,
      formActions(() => openForum(ch), "Post", submit),
    ]);
    title.input.focus();
  }

  async function openPost(ch, messageId) {
    view = "post";
    forumChannel = ch;
    renderLoading("Loading post…");
    const res = await api.getThread(messageId);
    if (!res.ok) return openForum(ch);
    if (view === "post") renderPost(ch, res.data);
  }

  function renderPost(ch, thread) {
    const members = memberMap();
    const post = thread.parent;
    const { title, body } = splitTopic(post.content);
    const author = members.get(post.senderId);

    const head = el(
      "div",
      { class: "forum-post__head" },
      el("h1", { class: "forum-post__title", text: title || "(untitled)" }),
      el(
        "div",
        { class: "forum-post__by" },
        memberAvatar(author || { displayName: "Member" }),
        el(
          "div",
          {},
          el("div", { class: "forum-post__author", text: author ? author.displayName : "Member" }),
          el("div", { class: "forum-post__time", text: timeAgo(post.createdAt) })
        )
      ),
      body ? el("div", { class: "forum-post__body", text: body }) : null
    );

    const replies = el("div", { class: "forum-replies" });
    replies.append(
      el("div", { class: "forum-replies__count", text: `${thread.replies.length} repl${thread.replies.length === 1 ? "y" : "ies"}` })
    );
    for (const r of thread.replies) {
      const ra = members.get(r.senderId);
      replies.append(
        el(
          "div",
          { class: "forum-reply" },
          memberAvatar(ra || { displayName: "Member" }),
          el(
            "div",
            { class: "forum-reply__body" },
            el(
              "div",
              { class: "forum-reply__meta" },
              el("span", { class: "forum-reply__author", text: ra ? ra.displayName : "Member" }),
              el("span", { class: "forum-reply__time", text: timeAgo(r.createdAt) })
            ),
            el("div", { class: "forum-reply__text", text: r.content || "" })
          )
        )
      );
    }

    const replyInput = el("textarea", {
      class: "field__input field__textarea",
      rows: "2",
      maxlength: "8000",
      placeholder: "Write a reply…",
    });
    const errBox = el("div", { class: "composer-error", hidden: true });
    const send = async () => {
      const content = replyInput.value.trim();
      if (!content) return;
      if (busy) return;
      busy = true;
      const res = await api.sendMessage(ch.chatId, { content, replyToId: post.id });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t reply.");
      openPost(ch, post.id);
    };
    const composer = el(
      "div",
      { class: "forum-post__composer" },
      replyInput,
      errBox,
      el("button", { class: "btn btn--primary", type: "button", onClick: send }, "Reply")
    );

    shell({ title: "🧵 Post", onBack: () => openForum(ch) }, el("div", { class: "forum-post" }, head, replies, composer));
  }

  function memberMap() {
    const m = new Map();
    for (const mem of current?.members || []) m.set(mem.user.id, mem.user);
    return m;
  }

  /** First line of a post is its title; the rest is the body. */
  function splitTopic(content) {
    const text = String(content || "");
    const nl = text.indexOf("\n");
    if (nl === -1) return { title: text.trim(), body: "" };
    return { title: text.slice(0, nl).trim(), body: text.slice(nl + 1).trim() };
  }

  /* -- Roles (custom) ------------------------------------------------------ */

  function openRoles() {
    view = "roles";
    renderRoles();
  }

  function renderRoles() {
    const s = current;
    const list = el("div", { class: "roles-list" });
    if (!s.roles.length) {
      list.append(
        el(
          "div",
          { class: "spaces-empty" },
          el("div", { class: "spaces-empty__glyph", text: "🎭" }),
          el("h3", { text: "No custom roles yet" }),
          el("p", { class: "spaces-empty__sub", text: "Create named, colored roles like “Verified Creator” and grant them permissions." })
        )
      );
    }
    for (const r of s.roles) {
      list.append(
        el(
          "div",
          { class: "role-card" },
          el("span", { class: "role-card__swatch", style: `background:${r.color || "#5b6bff"}` }),
          el(
            "div",
            { class: "role-card__meta" },
            el("div", { class: "role-card__name", text: r.name }),
            el("div", {
              class: "role-card__perms",
              text: r.permissions.length ? r.permissions.map(permLabel).join(" · ") : "No permissions",
            })
          ),
          el("button", { class: "member-row__act", type: "button", onClick: () => showRoleForm(r) }, "Edit"),
          el(
            "button",
            {
              class: "member-row__act member-row__act--danger",
              type: "button",
              onClick: async () => {
                if (!confirm(`Delete the “${r.name}” role?`)) return;
                const res = await api.deleteSpaceRole(s.id, r.id);
                if (!res.ok) return;
                const d = await api.getSpace(s.id);
                if (d.ok) current = d.data;
                openRoles();
              },
            },
            "Delete"
          )
        )
      );
    }
    const newBtn = el("button", { class: "btn btn--primary forum__new", type: "button", onClick: () => showRoleForm(null) }, "＋ New role");
    shell({ title: "🎭 Roles", onBack: () => openSpace(current.id) }, newBtn, list);
  }

  function showRoleForm(role) {
    const s = current;
    const editing = Boolean(role);
    const name = textField("Role name", "40");
    if (role) name.input.value = role.name;

    let color = role?.color || ROLE_COLORS[0];
    const swatches = el("div", { class: "role-swatches" });
    for (const c of ROLE_COLORS) {
      const b = el("button", {
        type: "button",
        class: "role-swatch" + (c === color ? " is-active" : ""),
        style: `background:${c}`,
        "aria-label": c,
        onClick: () => {
          color = c;
          swatches.querySelectorAll(".role-swatch").forEach((x) => x.classList.remove("is-active"));
          b.classList.add("is-active");
        },
      });
      swatches.append(b);
    }

    const held = new Set(role?.permissions || []);
    const permBoxes = el("div", { class: "perm-list" });
    for (const [key, label, desc] of PERMISSIONS) {
      const cb = el("input", { type: "checkbox", class: "perm-check" });
      cb.checked = held.has(key);
      cb.dataset.perm = key;
      permBoxes.append(
        el(
          "label",
          { class: "perm-row" },
          cb,
          el("span", {}, el("span", { class: "perm-row__label", text: label }), el("span", { class: "perm-row__desc", text: desc }))
        )
      );
    }

    const errBox = el("div", { class: "composer-error", hidden: true });
    const submit = async () => {
      const nm = name.input.value.trim();
      if (!nm) return showErr(errBox, "Name the role.");
      if (busy) return;
      const permissions = [...permBoxes.querySelectorAll(".perm-check")].filter((c) => c.checked).map((c) => c.dataset.perm);
      busy = true;
      const res = editing
        ? await api.updateSpaceRole(s.id, role.id, { name: nm, color, permissions })
        : await api.createSpaceRole(s.id, { name: nm, color, permissions });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t save the role.");
      current = res.data;
      openRoles();
    };

    formShell(editing ? "🎭 Edit role" : "🎭 New role", () => openRoles(), [
      name.wrap,
      el("label", { class: "field__label", text: "Color" }),
      swatches,
      el("label", { class: "field__label", text: "Permissions" }),
      permBoxes,
      errBox,
      formActions(() => openRoles(), editing ? "Save role" : "Create role", submit),
    ]);
    name.input.focus();
  }

  /* -- Forms --------------------------------------------------------------- */

  function showCreateForm() {
    const name = textField("Space name", "80");
    const desc = textField("Description (optional)", "280");
    const errBox = el("div", { class: "composer-error", hidden: true });
    let visibility = "private";
    const vis = segmented(
      [
        ["private", "🔒 Private"],
        ["public", "🌍 Public"],
      ],
      visibility,
      (v) => (visibility = v)
    );
    const submit = async () => {
      if (!name.input.value.trim()) return showErr(errBox, "Give your Space a name.");
      if (busy) return;
      busy = true;
      const res = await api.createSpace({
        name: name.input.value.trim(),
        description: desc.input.value.trim() || undefined,
        visibility,
      });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t create the Space.");
      await loadList();
      openSpace(res.data.id);
    };
    formShell("🌐 New Space", () => renderList(), [
      name.wrap,
      desc.wrap,
      el("label", { class: "field__label", text: "Visibility" }),
      vis,
      errBox,
      formActions(() => renderList(), "Create Space", submit),
    ]);
    name.input.focus();
  }

  function showJoinForm() {
    const idf = textField("Space @handle or ID", "60");
    const errBox = el("div", { class: "composer-error", hidden: true });
    const submit = async () => {
      const raw = idf.input.value.trim().replace(/^@/, "");
      if (!raw) return showErr(errBox, "Enter a Space handle or ID.");
      if (busy) return;
      busy = true;
      const res = await api.joinSpace(raw);
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t join that Space.");
      await loadList();
      openSpace(res.data.id);
    };
    formShell("🌐 Join a Space", () => renderList(), [
      el("p", { class: "spaces-form__hint", text: "Ask an admin for the Space’s @handle or ID, then paste it here." }),
      idf.wrap,
      errBox,
      formActions(() => renderList(), "Join", submit),
    ]);
    idf.input.focus();
  }

  function showChannelForm() {
    const s = current;
    const name = textField("Channel name", "60");
    const icon = textField("Icon (optional)", "4");
    const cat = textField("Section (e.g. Channels)", "40");
    cat.input.value = "Channels";
    let kind = "text";
    const kindSeg = segmented(
      Object.entries(KIND_LABEL),
      kind,
      (v) => (kind = v),
      "segmented--wrap"
    );
    const errBox = el("div", { class: "composer-error", hidden: true });
    const submit = async () => {
      if (!name.input.value.trim()) return showErr(errBox, "Name the channel.");
      if (busy) return;
      busy = true;
      const res = await api.createSpaceChannel(s.id, {
        name: name.input.value.trim(),
        icon: icon.input.value.trim() || undefined,
        kind,
        category: cat.input.value.trim() || undefined,
      });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t create the channel.");
      openSpace(s.id);
    };
    formShell("🌐 New channel", () => openSpace(s.id), [
      name.wrap,
      el("label", { class: "field__label", text: "Type" }),
      kindSeg,
      icon.wrap,
      cat.wrap,
      errBox,
      formActions(() => openSpace(s.id), "Create channel", submit),
    ]);
    name.input.focus();
  }

  function showEditForm() {
    const s = current;
    const name = textField("Name", "80");
    name.input.value = s.name;
    const handle = textField("Handle", "24");
    handle.input.value = s.handle || "";
    const desc = textField("Description", "280");
    desc.input.value = s.description || "";
    const avatar = textField("Avatar URL", "2048");
    avatar.input.value = s.avatarUrl || "";
    const banner = textField("Banner URL", "2048");
    banner.input.value = s.bannerUrl || "";
    let visibility = s.visibility;
    const vis = segmented(
      [
        ["private", "🔒 Private"],
        ["public", "🌍 Public"],
      ],
      visibility,
      (v) => (visibility = v)
    );
    const errBox = el("div", { class: "composer-error", hidden: true });
    const submit = async () => {
      if (busy) return;
      const patch = {
        name: name.input.value.trim() || undefined,
        handle: handle.input.value.trim() || undefined,
        description: desc.input.value.trim() || null,
        avatarUrl: avatar.input.value.trim() || null,
        bannerUrl: banner.input.value.trim() || null,
        visibility,
      };
      busy = true;
      const res = await api.updateSpace(s.id, patch);
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t save changes.");
      current = res.data;
      renderSpace();
    };
    formShell("🌐 Space settings", () => renderSpace(), [
      name.wrap,
      handle.wrap,
      desc.wrap,
      el("label", { class: "field__label", text: "Visibility" }),
      vis,
      avatar.wrap,
      banner.wrap,
      errBox,
      formActions(() => renderSpace(), "Save changes", submit),
    ]);
    name.input.focus();
  }

  /* -- Small pieces -------------------------------------------------------- */

  function navItem(icon, label, active, onClick, onDelete = null, extraClass = "") {
    const item = el(
      "button",
      { class: "space-nav__item" + (active ? " is-active" : "") + (extraClass ? " " + extraClass : ""), type: "button", onClick },
      el("span", { class: "space-nav__icon", text: icon }),
      el("span", { class: "space-nav__label", text: label })
    );
    if (onDelete) {
      item.append(
        el(
          "span",
          {
            class: "space-nav__del",
            title: "Delete channel",
            onClick: (e) => {
              e.stopPropagation();
              onDelete();
            },
          },
          "✕"
        )
      );
    }
    return item;
  }

  function statChip(value, label, online = false) {
    return el(
      "div",
      { class: "space-stat" + (online ? " space-stat--online" : "") },
      el("span", { class: "space-stat__value", text: value }),
      el("span", { class: "space-stat__label", text: label })
    );
  }

  function homeTile(icon, title, sub, onClick) {
    return el(
      "button",
      { class: "space-home__tile", type: "button", onClick },
      el("span", { class: "space-home__tile-icon", text: icon }),
      el("span", { class: "space-home__tile-title", text: title }),
      el("span", { class: "space-home__tile-sub", text: sub })
    );
  }

  function textField(label, maxlength) {
    const input = el("input", { class: "field__input", type: "text", maxlength, autocomplete: "off", spellcheck: "false" });
    const wrap = el("label", { class: "field" }, el("span", { class: "field__label", text: label }), input);
    return { wrap, input };
  }

  function segmented(entries, initial, onPick, extra = "") {
    const seg = el("div", { class: "segmented " + extra });
    for (const [val, label] of entries) {
      const b = el(
        "button",
        {
          type: "button",
          class: "segmented__btn" + (val === initial ? " is-active" : ""),
          onClick: () => {
            seg.querySelectorAll(".segmented__btn").forEach((x) => x.classList.remove("is-active"));
            b.classList.add("is-active");
            onPick(val);
          },
        },
        label
      );
      seg.append(b);
    }
    return seg;
  }

  function formActions(onCancel, label, onSubmit) {
    return el(
      "div",
      { class: "spaces-form__actions" },
      el("button", { class: "btn btn--ghost", type: "button", onClick: onCancel }, "Cancel"),
      el("button", { class: "btn btn--primary", type: "button", onClick: onSubmit }, label)
    );
  }

  function formShell(title, onBack, children) {
    shell({ title, onBack }, el("div", { class: "spaces-form" }, ...children.filter(Boolean)));
  }

  function backToList() {
    view = "list";
    renderList();
  }

  function spaceAvatar(s, size = "") {
    const cls = "space-avatar" + (size ? " space-avatar--" + size : "");
    const node = el("span", { class: cls, style: gradientFor(s.name) });
    if (s.avatarUrl) {
      node.classList.add("space-avatar--img");
      node.setAttribute("style", `background-image:url("${cssUrl(s.avatarUrl)}")`);
    } else {
      node.append(document.createTextNode(initials(s.name)));
    }
    return node;
  }

  function memberAvatar(u) {
    const node = el("span", { class: "member-avatar", style: gradientFor(u.displayName) });
    if (u.avatarUrl) {
      node.classList.add("space-avatar--img");
      node.setAttribute("style", `background-image:url("${cssUrl(u.avatarUrl)}")`);
    } else {
      node.append(document.createTextNode(initials(u.displayName)));
    }
    return node;
  }

  function roleBadge(role) {
    if (!role || role === "member") return null;
    return el("span", { class: `role-badge role-badge--${role}`, text: ROLE_LABEL[role] || role });
  }

  function gradientFor(seed) {
    const h = avatarHue(seed);
    return `background:linear-gradient(135deg,hsl(${h} 70% 55%),hsl(${(h + 40) % 360} 70% 45%));`;
  }
  function cssUrl(u) {
    return String(u).replace(/["'()\\]/g, (c) => "%" + c.charCodeAt(0).toString(16));
  }
  function showErr(box, msg) {
    box.textContent = msg;
    box.hidden = false;
  }
  function sectionRank(name) {
    const i = SECTION_ORDER.indexOf(name);
    return i === -1 ? SECTION_ORDER.length : i;
  }
  function fmt(n) {
    return Number(n || 0).toLocaleString();
  }
  function permLabel(key) {
    const p = PERMISSIONS.find((x) => x[0] === key);
    return p ? p[1] : key;
  }
  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function preview(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > 100 ? t.slice(0, 97) + "…" : t;
  }
  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function closeIcon() {
    return svg('<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
  }
  function backIcon() {
    return svg('<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
  }
  function gearIcon() {
    return svg(
      '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    );
  }
  function svg(inner) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = inner; // static, trusted markup — no user content
    return s;
  }

  return { mount, open, close, reopenSpace, onSpaceUpdated };
}
