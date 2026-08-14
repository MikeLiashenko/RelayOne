/**
 * RelayOne — Welcome screen behavior
 *
 * Responsibilities:
 *   1. Trigger the entrance choreography once the page is painted.
 *   2. Provide lightweight navigation hooks toward the (upcoming) auth screens.
 *
 * The markup already ships the buttons as accessible anchors, so the screen
 * works with JavaScript disabled. This script only enhances it.
 */

/* -- 1. Entrance animation ------------------------------------------------- */

function playIntro() {
  const root = document.querySelector(".welcome");
  if (!root) return;

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  // Opt the tree into the animated (initially-hidden) state.
  root.classList.add("is-animated");

  if (prefersReducedMotion) {
    root.classList.add("is-ready");
    return;
  }

  const reveal = () => root.classList.add("is-ready");

  // Next frame → let the browser register the hidden state, then reveal.
  requestAnimationFrame(() => requestAnimationFrame(reveal));

  // Safety net: rAF is paused while a tab is backgrounded / not compositing,
  // which would otherwise leave the content stuck at opacity 0. A short timer
  // guarantees the reveal regardless. `is-ready` is idempotent.
  setTimeout(reveal, 400);
}

/* -- 2. Navigation hooks --------------------------------------------------- */

import { resolveRoute } from "./routes.js";

/**
 * Navigate to a named route. The Welcome buttons already carry the resolved
 * href, so this is primarily for programmatic navigation; it stays in sync
 * with the anchors via the shared route map.
 *
 * @param {string} route  e.g. "create-account" | "login"
 */
function navigateTo(route) {
  window.location.assign(resolveRoute(route));
}

function wireActions() {
  const buttons = document.querySelectorAll("[data-route]");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      // Surface intent for observers, then let the anchor's href navigate
      // (works without JS and keeps a single source of truth in routes.js).
      document.dispatchEvent(
        new CustomEvent("relayone:navigate", {
          detail: { route: button.dataset.route },
        })
      );
    });
  });
}

/* -- Boot ------------------------------------------------------------------ */

function init() {
  playIntro();
  wireActions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export { navigateTo };
