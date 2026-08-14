/**
 * RelayOne — Button factory
 *
 * Reusable across the auth flow (welcome, sign-up, log-in …). Produces a
 * semantic element that renders with the shared `.btn` styles.
 *
 * @typedef {Object} ButtonOptions
 * @property {string}  label                 Visible text.
 * @property {"primary"|"secondary"} [variant="primary"]
 * @property {string}  [href]                Render as an <a> to this target.
 * @property {"button"|"submit"} [type="button"]  Used when no href is given.
 * @property {(event: Event) => void} [onClick]
 * @property {Record<string,string>}  [dataset]  Extra data-* attributes.
 *
 * @param {ButtonOptions} options
 * @returns {HTMLAnchorElement | HTMLButtonElement}
 */
export function createButton(options) {
  const {
    label,
    variant = "primary",
    href,
    type = "button",
    onClick,
    dataset = {},
  } = options;

  const el = document.createElement(href ? "a" : "button");
  el.className = `btn btn--${variant}`;
  el.textContent = label;

  if (href) {
    el.setAttribute("href", href);
  } else {
    el.setAttribute("type", type);
  }

  for (const [key, value] of Object.entries(dataset)) {
    el.dataset[key] = value;
  }

  if (typeof onClick === "function") {
    el.addEventListener("click", onClick);
  }

  return el;
}
