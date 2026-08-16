/**
 * RelayOne Spaces — communities UI (Discord-like).
 *
 * Self-contained overlay: a list of the Spaces you're in, and a detail view
 * with channels + members + role-gated management. Channels are backed by
 * normal chats, so opening a text channel hands off to the app's regular chat
 * view; voice channels start a group call. All DOM is built with `el()` and
 * user content goes through textContent — never innerHTML.
 */
import { $, clear, el, initials, avatarHue } from "../dom.js";

const RANK = { owner: 3, admin: 2, moderator: 1, member: 0 };
const ROLE_LABEL = { owner: "Owner", admin: "Admin", moderator: "Moderator", member: "Member" };

export function createSpaces({ api, getMe, openChannel, startChannelCall }) {
  let root = null;
  let view = "list"; // "list" | "detail"
  let spaces = [];
  let current = null; // SpaceDetail
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

  /** Re-show the detail view for a Space (used by the chat "back" button). */
  async function reopenSpace(spaceId) {
    mount();
    root.hidden = false;
    await openDetail(spaceId);
  }

  async function loadList() {
    renderLoading("Loading your Spaces…");
    const res = await api.listSpaces();
    spaces = res.ok ? res.data : [];
    if (view === "list") renderList();
  }

  async function openDetail(spaceId) {
    view = "detail";
    renderLoading("Opening Space…");
    const res = await api.getSpace(spaceId);
    if (!res.ok) {
      view = "list";
      await loadList();
      return;
    }
    current = res.data;
    if (view === "detail") renderDetail();
  }

  /** Realtime: a Space changed — refresh whatever is on screen. */
  async function onSpaceUpdated(spaceId) {
    if (!root || root.hidden) return;
    if (view === "detail" && current?.id === spaceId) {
      const res = await api.getSpace(spaceId);
      if (res.ok) {
        current = res.data;
        renderDetail();
      } else {
        // We were removed / it was deleted.
        current = null;
        view = "list";
        await loadList();
      }
    } else if (view === "list") {
      await loadList();
    }
  }

  /* -- Rendering ----------------------------------------------------------- */

  function shell(title, ...body) {
    clear(root);
    const card = el(
      "div",
      { class: "spaces-card" },
      el(
        "header",
        { class: "spaces-card__head" },
        el("h2", { class: "spaces-card__title", text: title }),
        el(
          "button",
          { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onClick: close },
          closeIcon()
        )
      ),
      ...body
    );
    root.append(card);
    return card;
  }

  function renderLoading(msg) {
    shell("🌐 Spaces", el("div", { class: "spaces-loading" }, el("span", { class: "spinner" }), msg));
  }

  function renderList() {
    const body = el("div", { class: "spaces-list" });

    if (spaces.length === 0) {
      body.append(
        el(
          "div",
          { class: "spaces-empty" },
          el("div", { class: "spaces-empty__glyph", text: "🌐" }),
          el("p", { text: "You’re not in any Spaces yet." }),
          el("p", { class: "spaces-empty__sub", text: "Create a community, or join one with its ID." })
        )
      );
    } else {
      for (const s of spaces) {
        body.append(
          el(
            "button",
            { class: "space-row", type: "button", onClick: () => openDetail(s.id) },
            spaceAvatar(s),
            el(
              "span",
              { class: "space-row__meta" },
              el("span", { class: "space-row__name", text: s.name }),
              el(
                "span",
                { class: "space-row__sub", text: `${s.memberCount} member${s.memberCount === 1 ? "" : "s"}` }
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
      el(
        "button",
        { class: "btn btn--primary", type: "button", onClick: showCreateForm },
        "＋ New Space"
      ),
      el("button", { class: "btn btn--ghost", type: "button", onClick: showJoinForm }, "Join by ID")
    );

    shell("🌐 Spaces", body, actions);
  }

  function showCreateForm() {
    const nameInput = el("input", {
      class: "field__input",
      type: "text",
      maxlength: "80",
      placeholder: "Space name",
    });
    const descInput = el("input", {
      class: "field__input",
      type: "text",
      maxlength: "280",
      placeholder: "What’s it about? (optional)",
    });
    const errBox = el("div", { class: "composer-error", hidden: true });

    const submit = async () => {
      const name = nameInput.value.trim();
      if (!name) return showErr(errBox, "Give your Space a name.");
      if (busy) return;
      busy = true;
      const res = await api.createSpace({ name, description: descInput.value.trim() || undefined });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t create the Space.");
      await loadList();
      openDetail(res.data.id);
    };
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    shell(
      "🌐 New Space",
      el(
        "div",
        { class: "spaces-form" },
        el("label", { class: "field__label", text: "Name" }),
        nameInput,
        el("label", { class: "field__label", text: "Description" }),
        descInput,
        errBox,
        el(
          "div",
          { class: "spaces-form__actions" },
          el("button", { class: "btn btn--ghost", type: "button", onClick: () => renderBack() }, "Cancel"),
          el("button", { class: "btn btn--primary", type: "button", onClick: submit }, "Create Space")
        )
      )
    );
    nameInput.focus();
  }

  function showJoinForm() {
    const idInput = el("input", {
      class: "field__input",
      type: "text",
      placeholder: "Space ID (UUID)",
      autocomplete: "off",
      spellcheck: "false",
    });
    const errBox = el("div", { class: "composer-error", hidden: true });

    const submit = async () => {
      const id = idInput.value.trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return showErr(errBox, "That doesn’t look like a Space ID.");
      if (busy) return;
      busy = true;
      const res = await api.joinSpace(id);
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t join that Space.");
      await loadList();
      openDetail(id);
    };
    idInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    shell(
      "🌐 Join a Space",
      el(
        "div",
        { class: "spaces-form" },
        el("label", { class: "field__label", text: "Paste a Space ID to join" }),
        idInput,
        errBox,
        el(
          "div",
          { class: "spaces-form__actions" },
          el("button", { class: "btn btn--ghost", type: "button", onClick: () => renderBack() }, "Cancel"),
          el("button", { class: "btn btn--primary", type: "button", onClick: submit }, "Join")
        )
      )
    );
    idInput.focus();
  }

  function renderBack() {
    view = "list";
    renderList();
  }

  function renderDetail() {
    const s = current;
    const myRank = RANK[s.myRole] ?? 0;
    const meId = getMe()?.id;

    /* Header row with a back arrow + share-ID button. */
    const head = el(
      "div",
      { class: "space-detail__banner" },
      spaceAvatar(s, "lg"),
      el(
        "div",
        { class: "space-detail__id" },
        el("div", { class: "space-detail__name", text: s.name }),
        el("div", {
          class: "space-detail__sub",
          text: `${s.memberCount} member${s.memberCount === 1 ? "" : "s"} · you’re ${ROLE_LABEL[s.myRole]}`,
        }),
        s.description ? el("div", { class: "space-detail__desc", text: s.description }) : null
      )
    );

    /* Channels. */
    const chanList = el("div", { class: "space-channels" });
    for (const c of s.channels) {
      const isVoice = c.kind === "voice";
      const row = el(
        "button",
        {
          class: "channel-row",
          type: "button",
          onClick: () =>
            isVoice ? startChannelCall(c.chatId, s.id, "audio") : openChannel(c.chatId, s.id),
        },
        el("span", { class: "channel-row__icon", text: c.icon || (isVoice ? "🔊" : "#") }),
        el("span", { class: "channel-row__name", text: c.name }),
        c.kind === "announcement" ? el("span", { class: "channel-row__tag", text: "announce" }) : null,
        isVoice ? el("span", { class: "channel-row__tag channel-row__tag--voice", text: "voice" }) : null
      );
      if (myRank >= RANK.admin && s.channels.length > 1) {
        row.append(
          el(
            "span",
            {
              class: "channel-row__del",
              title: "Delete channel",
              onClick: async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete #${c.name}? Its messages are removed.`)) return;
                const res = await api.deleteSpaceChannel(c.id);
                if (res.ok) openDetail(s.id);
              },
            },
            "✕"
          )
        );
      }
      chanList.append(row);
    }
    if (myRank >= RANK.admin) {
      chanList.append(
        el(
          "button",
          { class: "channel-row channel-row--add", type: "button", onClick: () => showChannelForm(s) },
          el("span", { class: "channel-row__icon", text: "＋" }),
          el("span", { class: "channel-row__name", text: "Add channel" })
        )
      );
    }

    /* Members. */
    const memList = el("div", { class: "space-members" });
    for (const m of s.members) {
      const canManage = m.user.id !== meId && myRank > (RANK[m.role] ?? 0) && myRank >= RANK.admin;
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
        roleBadge(m.role)
      );
      if (canManage) row.append(memberMenu(s, m));
      memList.append(row);
    }

    /* Footer actions. */
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
              if (res.ok) renderBack();
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
              if (res.ok) renderBack();
            },
          },
          "Leave Space"
        )
      );
    }

    const card = shell(
      "🌐 " + s.name,
      el(
        "div",
        { class: "space-detail" },
        head,
        el(
          "div",
          { class: "space-detail__idline" },
          el("span", { class: "space-detail__idlabel", text: "Invite ID" }),
          el("code", { class: "space-detail__idcode", text: s.id }),
          el(
            "button",
            {
              class: "settings__btn-sm",
              type: "button",
              onClick: (e) => {
                navigator.clipboard?.writeText(s.id);
                e.currentTarget.textContent = "Copied";
                setTimeout(() => (e.currentTarget.textContent = "Copy"), 1200);
              },
            },
            "Copy"
          )
        ),
        el("h3", { class: "space-detail__section", text: "Channels" }),
        chanList,
        el("h3", { class: "space-detail__section", text: `Members · ${s.members.length}` }),
        memList,
        footer
      )
    );

    // A back button in the header returns to the Space list.
    card
      .querySelector(".spaces-card__head")
      .prepend(
        el(
          "button",
          { class: "icon-btn spaces-card__back", type: "button", title: "Back", "aria-label": "Back", onClick: renderBack },
          backIcon()
        )
      );
  }

  function showChannelForm(s) {
    const nameInput = el("input", {
      class: "field__input",
      type: "text",
      maxlength: "60",
      placeholder: "channel-name",
    });
    const iconInput = el("input", {
      class: "field__input",
      type: "text",
      maxlength: "4",
      placeholder: "Emoji (optional)",
    });
    const kindSeg = el(
      "div",
      { class: "segmented" },
      kindBtn("text", "💬 Text", true),
      kindBtn("announcement", "📢 Announce"),
      kindBtn("voice", "🔊 Voice")
    );
    let kind = "text";
    function kindBtn(val, label, active = false) {
      const b = el(
        "button",
        {
          type: "button",
          class: "segmented__btn" + (active ? " is-active" : ""),
          onClick: () => {
            kind = val;
            kindSeg.querySelectorAll(".segmented__btn").forEach((x) => x.classList.remove("is-active"));
            b.classList.add("is-active");
          },
        },
        label
      );
      return b;
    }
    const errBox = el("div", { class: "composer-error", hidden: true });

    const submit = async () => {
      const name = nameInput.value.trim();
      if (!name) return showErr(errBox, "Name the channel.");
      if (busy) return;
      busy = true;
      const res = await api.createSpaceChannel(s.id, { name, icon: iconInput.value.trim() || undefined, kind });
      busy = false;
      if (!res.ok) return showErr(errBox, res.error?.message || "Couldn’t create the channel.");
      openDetail(s.id);
    };

    const card = shell(
      "🌐 New channel",
      el(
        "div",
        { class: "spaces-form" },
        el("label", { class: "field__label", text: "Channel name" }),
        nameInput,
        el("label", { class: "field__label", text: "Icon" }),
        iconInput,
        el("label", { class: "field__label", text: "Type" }),
        kindSeg,
        errBox,
        el(
          "div",
          { class: "spaces-form__actions" },
          el("button", { class: "btn btn--ghost", type: "button", onClick: () => openDetail(s.id) }, "Cancel"),
          el("button", { class: "btn btn--primary", type: "button", onClick: submit }, "Create channel")
        )
      )
    );
    card
      .querySelector(".spaces-card__head")
      .prepend(
        el(
          "button",
          { class: "icon-btn spaces-card__back", type: "button", title: "Back", "aria-label": "Back", onClick: () => openDetail(s.id) },
          backIcon()
        )
      );
    nameInput.focus();
  }

  /** A tiny role/kick menu for a member the caller can manage. */
  function memberMenu(s, m) {
    const wrap = el("div", { class: "member-row__manage" });
    const canMakeAdmin = s.myRole === "owner" && m.role !== "admin";
    const opts = [];
    if (m.role !== "moderator") opts.push(["moderator", "Make moderator"]);
    if (m.role !== "member") opts.push(["member", "Make member"]);
    if (canMakeAdmin) opts.unshift(["admin", "Make admin"]);

    for (const [role, label] of opts) {
      wrap.append(
        el(
          "button",
          {
            class: "member-row__act",
            type: "button",
            title: label,
            onClick: async () => {
              const res = await api.setSpaceMemberRole(s.id, m.user.id, role);
              if (res.ok) openDetail(s.id);
            },
          },
          label
        )
      );
    }
    wrap.append(
      el(
        "button",
        {
          class: "member-row__act member-row__act--danger",
          type: "button",
          title: "Remove",
          onClick: async () => {
            if (!confirm(`Remove ${m.user.displayName} from the Space?`)) return;
            const res = await api.kickSpaceMember(s.id, m.user.id);
            if (res.ok) openDetail(s.id);
          },
        },
        "Remove"
      )
    );
    return wrap;
  }

  /* -- Small pieces -------------------------------------------------------- */

  function spaceAvatar(s, size = "") {
    const node = el("span", {
      class: "space-avatar" + (size === "lg" ? " space-avatar--lg" : ""),
      style: gradientFor(s.name),
    });
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
    return el("span", { class: `role-badge role-badge--${role}`, text: ROLE_LABEL[role] });
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
  function closeIcon() {
    return svg('<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
  }
  function backIcon() {
    return svg(
      '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
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
