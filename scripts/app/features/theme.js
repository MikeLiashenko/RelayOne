/**
 * RelayOne — Themes.
 *
 * Dark (default, the signature RelayOne look), Light, and System, plus an
 * accent color. Applied by stamping `data-theme` on <html> and overriding the
 * accent CSS variables; token overrides live in tokens.css. Persisted locally.
 */
const THEME_KEY = "relayone.theme"; // "dark" | "light" | "system"
const ACCENT_KEY = "relayone.accent";

export const ACCENTS = {
  blue: { label: "Blue", blue: "#168BFF", violet: "#713BFF" },
  violet: { label: "Violet", blue: "#7C4DFF", violet: "#B14BFF" },
  emerald: { label: "Emerald", blue: "#10B981", violet: "#0EA5A5" },
  sunset: { label: "Sunset", blue: "#FF8A3D", violet: "#FF4D8D" },
  rose: { label: "Rose", blue: "#FF5D8F", violet: "#A54BFF" },
  slate: { label: "Slate", blue: "#5B8DEF", violet: "#7C8AA5" },
};

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref() {
  return localStorage.getItem(THEME_KEY) || "dark";
}
export function getAccent() {
  return localStorage.getItem(ACCENT_KEY) || "blue";
}

function resolve(pref) {
  if (pref === "system") return media.matches ? "dark" : "light";
  return pref === "light" ? "light" : "dark";
}

function applyTheme(pref) {
  document.documentElement.setAttribute("data-theme", resolve(pref));
}
function applyAccent(id) {
  const a = ACCENTS[id] || ACCENTS.blue;
  const root = document.documentElement.style;
  root.setProperty("--color-blue", a.blue);
  root.setProperty("--color-violet", a.violet);
}

export function setTheme(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}
export function setAccent(id) {
  localStorage.setItem(ACCENT_KEY, id);
  applyAccent(id);
}

/** Apply saved preferences and keep System mode in sync with the OS. */
export function initTheme() {
  applyTheme(getThemePref());
  applyAccent(getAccent());
  media.addEventListener("change", () => {
    if (getThemePref() === "system") applyTheme("system");
  });
}
