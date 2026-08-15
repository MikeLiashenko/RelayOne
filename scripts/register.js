/**
 * RelayOne — Registration flow controller
 *
 * Drives the four-step account-creation flow. All backend interaction goes
 * through `authService` (a swappable mock), and all rules live in
 * `validators`, so this file is purely UI orchestration + state.
 */

import { authService } from "./auth/authService.js";
import {
  isValidEmail,
  isValidPhone,
  normalizePhone,
  isValidUsername,
  isValidDisplayName,
  maskDestination,
  USERNAME_HINT,
} from "./auth/validators.js";
import { createOtpInput } from "./components/otpInput.js";

/* -- Environment ----------------------------------------------------------- */

const prefersReduced = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* -- Shared UI helpers ----------------------------------------------------- */

function setMessage(el, tone, text) {
  if (!el) return;
  el.dataset.tone = tone;
  el.textContent = text;
  el.hidden = false;
}
function clearMessage(el) {
  if (el) el.hidden = true;
}
function setLoading(btn, loading) {
  btn.classList.toggle("is-loading", loading);
  btn.disabled = loading || btn.dataset.forceDisabled === "true";
}
function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

const ICONS = {
  spinner: '<span class="spinner" role="status" aria-label="Checking"></span>',
  check:
    '<svg class="status-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M5 13l4 4L19 7" stroke="var(--color-success)" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross:
    '<svg class="status-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M7 7l10 10M17 7L7 17" stroke="var(--color-danger)" stroke-width="2.2" ' +
    'stroke-linecap="round"/></svg>',
};

/* -- Application state ------------------------------------------------------ */

const state = {
  channel: "phone",
  identifier: "",
  displayName: "",
  username: "",
  usernameStatus: "empty", // empty | invalid | checking | available | taken
  avatarUrl: null, // object URL, for local preview only
  avatarFile: null, // the actual File, uploaded after the account is created
};

/* ========================================================================== */
/*  Step machine                                                              */
/* ========================================================================== */

const card = $(".auth-card");
const stepsWrap = $(".auth-steps");
const stepEls = {
  identify: $('[data-step="identify"]'),
  verify: $('[data-step="verify"]'),
  profile: $('[data-step="profile"]'),
  ready: $('[data-step="ready"]'),
};
const ORDER = ["identify", "verify", "profile", "ready"];
let currentName = "identify";
let animating = false;

function updateStepper(index) {
  $$(".stepper__dot").forEach((dot, i) => {
    dot.classList.toggle("is-active", i === index);
    dot.classList.toggle("is-done", i < index);
  });
}

function focusStep(el) {
  const target =
    el.querySelector("input:not([type=file]):not([disabled])") ||
    el.querySelector(".step__title");
  if (target) target.focus({ preventScroll: true });
}

function animateHeight(from, to) {
  stepsWrap.style.overflow = "hidden";
  stepsWrap.style.height = `${from}px`;
  // Force reflow so the starting height is committed before transitioning.
  void stepsWrap.offsetHeight;
  stepsWrap.style.transition = "height var(--dur-slow) var(--ease-out)";
  stepsWrap.style.height = `${to}px`;
  const done = () => {
    stepsWrap.style.height = "";
    stepsWrap.style.transition = "";
    stepsWrap.style.overflow = "";
    stepsWrap.removeEventListener("transitionend", done);
  };
  stepsWrap.addEventListener("transitionend", done);
  setTimeout(done, 500);
}

async function goToStep(name) {
  if (name === currentName || animating) return;
  animating = true;

  const current = stepEls[currentName];
  const next = stepEls[name];
  const index = ORDER.indexOf(name);

  card.dataset.activeStep = String(index + 1);
  updateStepper(index);

  if (prefersReduced) {
    current.hidden = true;
    current.classList.remove("step--active", "step--exit");
    next.hidden = false;
    next.classList.add("step--active");
  } else {
    const startH = stepsWrap.offsetHeight;
    current.classList.add("step--exit");
    await wait(150);
    current.hidden = true;
    current.classList.remove("step--active", "step--exit");

    next.hidden = false;
    next.classList.add("step--active");
    const endH = stepsWrap.offsetHeight;
    animateHeight(startH, endH);
  }

  currentName = name;
  onEnterStep(name, next);
  animating = false;
}

function goBack() {
  const index = ORDER.indexOf(currentName);
  if (index <= 0) return;
  goToStep(ORDER[index - 1]);
}

/** Per-step activation hooks (focus + any state refresh). */
function onEnterStep(name, el) {
  if (name === "verify") {
    otp.clear();
    startResendCountdown();
    $('[data-role="destination"]').textContent = maskDestination(
      state.channel,
      state.identifier
    );
  }
  if (name === "ready") {
    populatePreview();
  }
  focusStep(el);
}

/* ========================================================================== */
/*  STEP 1 — Identify (phone / email)                                         */
/* ========================================================================== */

const CHANNELS = {
  phone: {
    label: "Phone number",
    type: "tel",
    inputmode: "tel",
    autocomplete: "tel",
    placeholder: "Phone number",
    validate: isValidPhone,
    error: "Enter a valid phone number, including country code.",
  },
  email: {
    label: "Email address",
    type: "email",
    inputmode: "email",
    autocomplete: "email",
    placeholder: "Email address",
    validate: isValidEmail,
    error: "Enter a valid email address.",
  },
};

const identifyForm = $('[data-form="identify"]');
const identifierField = $('[data-field="identifier"]');
const identifierInput = $("#identifier");
const identifierMsg = $("#identifier-msg");
const identifySubmit = $('[data-action="submit-identify"]');
const segmented = $(".segmented");

const identifierValues = { phone: "", email: "" };

function applyChannel(channel) {
  const cfg = CHANNELS[channel];
  state.channel = channel;

  $$(".segmented__option").forEach((opt) => {
    const active = opt.dataset.channel === channel;
    opt.setAttribute("aria-selected", String(active));
  });
  segmented.dataset.active = channel;

  identifierField.querySelector(".field__label").textContent = cfg.label;
  identifierInput.type = cfg.type;
  identifierInput.inputMode = cfg.inputmode;
  identifierInput.autocomplete = cfg.autocomplete;
  identifierInput.placeholder = cfg.placeholder;

  identifierInput.value = identifierValues[channel];
  identifierField.classList.remove("is-invalid");
  clearMessage(identifierMsg);
  refreshIdentifySubmit();
}

function refreshIdentifySubmit() {
  identifySubmit.disabled = identifierInput.value.trim() === "";
}

$$(".segmented__option").forEach((opt) => {
  opt.addEventListener("click", () => applyChannel(opt.dataset.channel));
});

identifierInput.addEventListener("input", () => {
  identifierValues[state.channel] = identifierInput.value;
  identifierField.classList.remove("is-invalid");
  clearMessage(identifierMsg);
  refreshIdentifySubmit();
});

identifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cfg = CHANNELS[state.channel];
  const raw = identifierInput.value.trim();

  if (!cfg.validate(raw)) {
    identifierField.classList.add("is-invalid");
    setMessage(identifierMsg, "error", cfg.error);
    identifierInput.focus();
    return;
  }

  state.identifier =
    state.channel === "phone" ? normalizePhone(raw) : raw.toLowerCase();

  setLoading(identifySubmit, true);
  const res = await authService.startRegistration({
    channel: state.channel,
    identifier: state.identifier,
  });
  setLoading(identifySubmit, false);

  if (res.ok) {
    goToStep("verify");
  } else {
    identifierField.classList.add("is-invalid");
    setMessage(identifierMsg, "error", res.message ?? "Something went wrong.");
  }
});

/* ========================================================================== */
/*  STEP 2 — Verify                                                           */
/* ========================================================================== */

const verifyForm = $('[data-form="verify"]');
const verifySubmit = $('[data-action="submit-verify"]');
const verifyMsg = $('[data-role="verify-message"]');
const resendBtn = $('[data-action="resend"]');
const resendLabel = $('[data-role="resend-label"]');

let verifying = false;
let resendTimer = null;
const RESEND_SECONDS = 30;

const otp = createOtpInput($('[data-role="otp"]'), {
  length: 6,
  onChange: (value) => {
    verifySubmit.disabled = value.length !== 6 || !/^\d{6}$/.test(value);
    clearMessage(verifyMsg);
  },
  onComplete: () => submitVerify(),
});

function startResendCountdown() {
  clearInterval(resendTimer);
  let remaining = RESEND_SECONDS;
  resendBtn.disabled = true;

  const render = () => {
    const s = String(remaining % 60).padStart(2, "0");
    resendLabel.textContent = `You can resend the code in`;
    resendBtn.textContent = `0:${s}`;
  };
  render();

  resendTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(resendTimer);
      resendLabel.textContent = "Didn’t get the code?";
      resendBtn.textContent = "Resend code";
      resendBtn.disabled = false;
      return;
    }
    render();
  }, 1000);
}

resendBtn.addEventListener("click", async () => {
  if (resendBtn.disabled) return;
  resendBtn.disabled = true;
  resendLabel.textContent = "Sending…";
  resendBtn.textContent = "Resend code";
  await authService.resendCode();
  otp.clear();
  otp.focusFirst();
  clearMessage(verifyMsg);
  startResendCountdown();
});

async function submitVerify() {
  if (verifying || !otp.isComplete()) return;
  verifying = true;
  otp.setError(false);
  clearMessage(verifyMsg);
  setLoading(verifySubmit, true);

  const res = await authService.verifyCode(otp.value());
  setLoading(verifySubmit, false);
  verifying = false;

  if (res.ok) {
    clearInterval(resendTimer);
    goToStep("profile");
  } else {
    otp.setError(true);
    setMessage(
      verifyMsg,
      "error",
      res.message ?? "That code isn’t right. Check it and try again."
    );
    otp.focusFirst();
  }
}

verifyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitVerify();
});

/* Dev-only convenience: while the backend returns a devCode (no SMS/email
   provider connected yet), show it on the verify step and fill it on tap. This
   never appears in production, where no devCode is sent. */
const devHint = $('[data-role="dev-hint"]');
const devHintCode = $('[data-role="dev-hint-code"]');

function fillOtp(code) {
  $$(".otp__digit").forEach((el, i) => {
    el.value = code[i] ?? "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

document.addEventListener("relayone:devcode", (event) => {
  const code = event.detail?.code;
  if (!code || !devHint) return;
  devHintCode.textContent = code;
  devHint.hidden = false;
  devHint.onclick = () => fillOtp(code);
});

/* ========================================================================== */
/*  STEP 3 — Profile                                                          */
/* ========================================================================== */

const profileForm = $('[data-form="profile"]');
const displayNameInput = $("#displayName");
const displayNameField = $('[data-field="displayName"]');
const displayNameMsg = $('[data-field="displayName"] [data-role="message"]');
const usernameInput = $("#username");
const usernameField = $('[data-field="username"]');
const usernameMsg = $("#username-msg");
const usernameStatusEl = $('[data-role="username-status"]');
const profileSubmit = $('[data-action="submit-profile"]');

const avatarWrap = $('[data-role="avatar"]');
const avatarButton = $('[data-action="pick-avatar"]');
const avatarInput = $('[data-role="avatar-input"]');
const avatarImage = $('[data-role="avatar-image"]');

/* --- Avatar --- */
avatarButton.addEventListener("click", () => avatarInput.click());
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
avatarInput.addEventListener("change", () => {
  const file = avatarInput.files && avatarInput.files[0];
  avatarInput.value = ""; // allow re-picking the same file later
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    window.alert("Please choose an image file.");
    return;
  }
  if (file.size > AVATAR_MAX_BYTES) {
    window.alert("Image is too large — pick one under 5 MB.");
    return;
  }
  if (state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = URL.createObjectURL(file);
  state.avatarFile = file;
  avatarImage.src = state.avatarUrl;
  avatarWrap.classList.add("has-image");
});

/* --- Display name --- */
displayNameInput.addEventListener("input", () => {
  state.displayName = displayNameInput.value;
  displayNameField.classList.remove("is-invalid");
  clearMessage(displayNameMsg);
  refreshProfileSubmit();
});

/* --- Username (live availability) --- */
let usernameReq = 0;

function setUsernameStatus(status, message, tone = "muted") {
  state.usernameStatus = status;
  usernameField.classList.toggle("is-invalid", status === "invalid" || status === "taken");
  usernameField.classList.toggle("is-success", status === "available");

  usernameStatusEl.innerHTML =
    status === "checking"
      ? ICONS.spinner
      : status === "available"
      ? ICONS.check
      : status === "invalid" || status === "taken"
      ? ICONS.cross
      : "";

  setMessage(usernameMsg, tone, message);
  refreshProfileSubmit();
}

const runUsernameCheck = debounce(async (value) => {
  const reqId = ++usernameReq;
  setUsernameStatus("checking", "Checking availability…", "muted");
  const { status } = await authService.checkUsername(value);
  if (reqId !== usernameReq) return; // a newer keystroke superseded this one
  if (status === "available") {
    setUsernameStatus("available", `@${value} is available.`, "success");
  } else {
    setUsernameStatus("taken", `@${value} is already taken.`, "error");
  }
}, 450);

usernameInput.addEventListener("input", () => {
  // Allow users to type a leading "@" without it becoming part of the handle.
  let value = usernameInput.value.replace(/^@+/, "");
  if (value !== usernameInput.value) usernameInput.value = value;
  value = value.trim();
  state.username = value;
  runUsernameCheck.cancel();

  if (value === "") {
    setUsernameStatus("empty", USERNAME_HINT, "muted");
    return;
  }
  if (!isValidUsername(value)) {
    setUsernameStatus("invalid", USERNAME_HINT, "error");
    return;
  }
  runUsernameCheck(value);
});

function refreshProfileSubmit() {
  const ready =
    isValidDisplayName(state.displayName) &&
    state.usernameStatus === "available";
  profileSubmit.disabled = !ready;
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isValidDisplayName(state.displayName)) {
    displayNameField.classList.add("is-invalid");
    setMessage(displayNameMsg, "error", "Please enter a display name.");
    displayNameInput.focus();
    return;
  }
  if (state.usernameStatus !== "available") return;

  setLoading(profileSubmit, true);
  const res = await authService.completeProfile({
    identifier: state.identifier,
    channel: state.channel,
    displayName: state.displayName.trim(),
    username: state.username,
    avatarFile: state.avatarFile,
  });
  setLoading(profileSubmit, false);

  if (res.ok) {
    goToStep("ready");
  } else {
    setUsernameStatus("taken", res.message ?? "Couldn’t create your account.", "error");
  }
});

/* ========================================================================== */
/*  STEP 4 — Ready (preview)                                                  */
/* ========================================================================== */

function populatePreview() {
  const name = state.displayName.trim();
  $('[data-role="preview-name"]').textContent = name;
  $('[data-role="preview-handle"]').textContent = `@${state.username}`;

  const avatarEl = $('[data-role="preview-avatar"]');
  if (state.avatarUrl) {
    avatarEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = state.avatarUrl;
    img.alt = "";
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (name[0] || "@").toUpperCase();
  }
}

/* ========================================================================== */
/*  Global wiring                                                             */
/* ========================================================================== */

$('[data-action="back"]').addEventListener("click", goBack);

// Initialise step 1.
applyChannel("phone");
setUsernameStatus("empty", USERNAME_HINT, "muted");
