/**
 * RelayOne — Route map
 *
 * Single source of truth for where the flow's named routes lead. Keeping it
 * here means the Welcome Screen, the auth flow and any future screen navigate
 * consistently, and swapping to a real router later touches only this file.
 */
export const ROUTES = {
  "create-account": "register.html",
  login: "login.html",
  app: "app.html",
  welcome: "index.html",
};

/** Resolve a named route to a URL (falls back to a hash for unknown names). */
export function resolveRoute(name) {
  return ROUTES[name] || `#/${name}`;
}
