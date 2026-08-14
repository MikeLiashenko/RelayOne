/**
 * RelayOne — Folders.
 *
 * Organizes the chat list into tabs: built-in All / Personal / Groups /
 * Favorites plus user-created custom folders, each with an unread counter.
 * Membership + favorites are stored locally (per browser) so this ships without
 * a schema change; a server-backed version can replace the storage later.
 */
import { el } from "../dom.js";

const DEFS_KEY = "relayone.folders.defs";
const ACTIVE_KEY = "relayone.folders.active";
const BYCHAT_KEY = "relayone.folders.byChat";

const BUILTINS = [
  { id: "all", name: "All" },
  { id: "personal", name: "Personal" },
  { id: "groups", name: "Groups" },
  { id: "favorites", name: "Favorites" },
];

export function createFolders({ getChats, onChange }) {
  let custom = load(DEFS_KEY, []);
  let byChat = load(BYCHAT_KEY, {});
  let active = localStorage.getItem(ACTIVE_KEY) || "all";

  function load(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function save() {
    localStorage.setItem(DEFS_KEY, JSON.stringify(custom));
    localStorage.setItem(BYCHAT_KEY, JSON.stringify(byChat));
    localStorage.setItem(ACTIVE_KEY, active);
  }
  function meta(id) {
    return byChat[id] || { fav: false, folders: [] };
  }
  function allFolders() {
    return [...BUILTINS, ...custom];
  }

  function matches(chat, folderId = active) {
    const m = meta(chat.id);
    switch (folderId) {
      case "all": return true;
      case "personal": return chat.type === "direct";
      case "groups": return chat.type === "group";
      case "favorites": return Boolean(m.fav);
      default: return (m.folders || []).includes(folderId);
    }
  }
  function unreadFor(folderId, chats) {
    return chats.reduce((n, c) => (matches(c, folderId) ? n + (c.unreadCount || 0) : n), 0);
  }

  function setActive(id) {
    active = id;
    save();
    render();
    onChange();
  }
  function toggleFav(chatId) {
    const m = meta(chatId);
    byChat[chatId] = { ...m, fav: !m.fav };
    save();
    render();
    onChange();
  }
  function toggleMembership(chatId, folderId) {
    const m = meta(chatId);
    const set = new Set(m.folders || []);
    set.has(folderId) ? set.delete(folderId) : set.add(folderId);
    byChat[chatId] = { ...m, folders: [...set] };
    save();
    render();
    onChange();
  }
  function addFolder(name) {
    const id = "f" + Date.now();
    custom = [...custom, { id, name: name.slice(0, 24) }];
    active = id;
    save();
    render();
    onChange();
    return id;
  }
  function removeFolder(id) {
    custom = custom.filter((f) => f.id !== id);
    for (const k of Object.keys(byChat)) {
      byChat[k] = { ...byChat[k], folders: (byChat[k].folders || []).filter((f) => f !== id) };
    }
    if (active === id) active = "all";
    save();
    render();
    onChange();
  }

  function render() {
    const bar = document.querySelector('[data-role="folders"]');
    if (!bar) return;
    const chats = getChats();
    bar.replaceChildren();

    for (const f of allFolders()) {
      const count = f.id === "all" ? 0 : unreadFor(f.id, chats);
      const isCustom = f.id.startsWith("f");
      const tab = el(
        "button",
        {
          class: "folder-tab" + (f.id === active ? " is-active" : ""),
          type: "button",
          title: isCustom ? "Double-click to delete" : f.name,
          onClick: () => setActive(f.id),
          onDblclick: isCustom
            ? () => { if (confirm(`Delete folder "${f.name}"?`)) removeFolder(f.id); }
            : null,
        },
        f.name
      );
      if (count > 0) tab.append(el("span", { class: "folder-tab__count" }, String(count)));
      bar.append(tab);
    }

    bar.append(
      el(
        "button",
        {
          class: "folder-tab folder-tab--add",
          type: "button",
          title: "New folder",
          onClick: () => {
            const name = prompt("Folder name");
            if (name && name.trim()) addFolder(name.trim());
          },
        },
        "+"
      )
    );
  }

  /* Per-chat popover menu: favorite toggle + folder membership. */
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener("click", onDocClick, true);
  }
  function onDocClick(e) {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  }
  function openChatMenu(chatId, anchor) {
    closeMenu();
    const m = meta(chatId);
    const menu = el("div", { class: "folder-menu" });

    menu.append(
      el("button", { class: "folder-menu__item", type: "button",
        onClick: () => { toggleFav(chatId); closeMenu(); } },
        m.fav ? "★  Remove from Favorites" : "☆  Add to Favorites")
    );
    if (custom.length) menu.append(el("div", { class: "folder-menu__sep" }, "Folders"));
    for (const f of custom) {
      const on = (m.folders || []).includes(f.id);
      menu.append(
        el("button", { class: "folder-menu__item" + (on ? " is-on" : ""), type: "button",
          onClick: () => { toggleMembership(chatId, f.id); closeMenu(); } },
          (on ? "✓  " : "") + f.name)
      );
    }
    menu.append(
      el("button", { class: "folder-menu__item folder-menu__item--new", type: "button",
        onClick: () => {
          const name = prompt("New folder name");
          if (name && name.trim()) toggleMembership(chatId, addFolder(name.trim()));
          closeMenu();
        } },
        "+  New folder…")
    );

    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    openMenu = menu;
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  }

  return { render, matches, setActive, getActive: () => active, openChatMenu, isFav: (id) => meta(id).fav };
}
