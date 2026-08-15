/**
 * RelayOne — a tiny, safe Markdown renderer for message text.
 *
 * Builds real DOM nodes (createElement / createTextNode) — it never assigns
 * user text to innerHTML, so it can't inject markup (XSS-safe by construction).
 * Supports a deliberately small subset:
 *   **bold**  *italic* / _italic_  `code`  ~~strike~~
 *   [label](https://url)  bare https:// links  and newlines.
 */

function makeEl(tag, children) {
  const node = document.createElement(tag);
  for (const c of children) node.append(c);
  return node;
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : null;
}

function linkNode(url, label) {
  const href = safeUrl(url);
  if (!href) return document.createTextNode(label);
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "md-link";
  a.textContent = label;
  return a;
}

function codeNode(text) {
  const c = document.createElement("code");
  c.className = "md-code";
  c.textContent = text;
  return c;
}

// Ordered so multi-char markers (**), (~~) win over single (*), and code is
// matched first so markers inside `code` stay literal.
const PATTERNS = [
  { re: /`([^`]+)`/, make: (m) => codeNode(m[1]) },
  { re: /\*\*([^*]+?)\*\*/, make: (m) => makeEl("strong", inlineToNodes(m[1])) },
  { re: /~~([^~]+?)~~/, make: (m) => makeEl("s", inlineToNodes(m[1])) },
  { re: /\*([^*]+?)\*/, make: (m) => makeEl("em", inlineToNodes(m[1])) },
  { re: /_([^_]+?)_/, make: (m) => makeEl("em", inlineToNodes(m[1])) },
  { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, make: (m) => linkNode(m[2], m[1]) },
  { re: /(https?:\/\/[^\s<>"')]+)/, make: (m) => linkNode(m[1], m[1]) },
];

function inlineToNodes(text) {
  const nodes = [];
  let rest = text;
  let guard = 0;
  while (rest.length && guard++ < 500) {
    let best = null;
    for (const p of PATTERNS) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { p, m };
    }
    if (!best) {
      nodes.push(document.createTextNode(rest));
      break;
    }
    if (best.m.index > 0) nodes.push(document.createTextNode(rest.slice(0, best.m.index)));
    nodes.push(best.p.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return nodes;
}

/** Render message text to a DocumentFragment of safe DOM nodes. */
export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, i) => {
    if (i > 0) frag.append(document.createElement("br"));
    for (const node of inlineToNodes(line)) frag.append(node);
  });
  return frag;
}
