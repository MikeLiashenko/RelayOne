/**
 * Guest guard for the Welcome / register / login pages: if a valid session
 * already exists, send the user straight to the main interface.
 */
import { requireGuest } from "./auth/session.js";

requireGuest("app.html");
