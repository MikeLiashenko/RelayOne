/**
 * RelayOne roadmap.
 * `status`: "live" (usable now) | "soon" (planned).
 * `isNew`: part of the latest feature batch — the "What's new" modal shows these,
 *          newest first. The rest are earlier/foundational features.
 */
export const ROADMAP = [
  // ── Latest batch (newest first) ──────────────────────────────────────────
  { icon: "🗳️", title: "Quiz polls", status: "live", isNew: true, desc: "Mark a correct answer; voters see if they got it right." },
  { icon: "📊", title: "Polls", status: "live", isNew: true, desc: "Single or multiple choice, anonymous, closeable, live results." },
  { icon: "🧵", title: "Threads", status: "live", isNew: true, desc: "Open a discussion of replies under any message." },
  { icon: "✏️", title: "Rich editor", status: "live", isNew: true, desc: "Markdown, formatting toolbar, emoji picker and edit history." },
  { icon: "📎", title: "Shared media", status: "live", isNew: true, desc: "Per-chat Media / Files / Links / Voice tabs." },
  { icon: "🔗", title: "Message links", status: "live", isNew: true, desc: "Copy a link to any message that jumps straight to it." },
  { icon: "✨", title: "Message effects", status: "live", isNew: true, desc: "Confetti, hearts, fire and stars on reactions." },
  { icon: "🖼️", title: "Media viewer", status: "live", isNew: true, desc: "In-app image lightbox and file preview (PDF, video, audio, text)." },
  { icon: "📞", title: "Calls", status: "live", isNew: true, desc: "1:1 and group audio/video calls over WebRTC." },
  { icon: "🚫", title: "Privacy", status: "live", isNew: true, desc: "Control who can message you, and who sees your avatar & last seen." },
  { icon: "🛡️", title: "Security center", status: "live", isNew: true, desc: "See your active sessions and sign out other devices." },
  { icon: "🔔", title: "Push notifications", status: "live", isNew: true, desc: "Get notified for new messages even when RelayOne is closed." },
  { icon: "📊", title: "Storage manager", status: "live", isNew: true, desc: "See local cache usage by type and clear it." },
  { icon: "🖥️", title: "Multi-device", status: "live", isNew: true, desc: "One account across browsers & devices, kept in sync in real time." },
  { icon: "🔎", title: "Global search", status: "live", isNew: true, desc: "Search people, chats and message text at once." },
  // ── Earlier / foundational features ───────────────────────────────────────
  { icon: "🗂️", title: "Folders", status: "live", desc: "Personal, Groups, Favorites & custom folders with unread counters." },
  { icon: "📝", title: "Drafts", status: "live", desc: "Unsent text is kept per chat and restored when you come back." },
  { icon: "↩️", title: "Reply & quote", status: "live", desc: "Reply to a message and jump straight to the original." },
  { icon: "🎨", title: "Themes", status: "live", desc: "Dark, Light, System and an accent color of your choice." },
  { icon: "👤", title: "User profile", status: "live", desc: "Avatar, name, bio, groups in common, Message & Call." },
  { icon: "🟢", title: "Presence", status: "live", desc: "Online, Away, Do not disturb, Offline." },
  { icon: "⭐", title: "Saved Messages", status: "live", desc: "A private chat with yourself for notes, files and links." },
  { icon: "📌", title: "Pinned messages", status: "live", desc: "Pin key messages with a dedicated pinned panel." },
  { icon: "🔗", title: "Link previews", status: "live", desc: "Rich cards with title, description and image for links." },
];
