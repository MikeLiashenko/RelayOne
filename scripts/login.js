/**
 * RelayOne — Login flow controller
 *
 * Two steps against the backend: identifier (phone/email, auto-detected) →
 * request code → verify → authenticated session → main interface. Reuses the
 * OTP component, validators and the shared auth service.
 */
import { authService } from "./auth/authService.js";
import { requireGuest } from "./auth/session.js";
import { createOtpInput } from "./components/otpInput.js";
import {
  isValidEmail,
  isValidPhone,
  maskDestination,
  normalizePhone,
} from "./auth/validators.js";

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Already signed in? Go straight to the app.
requireGuest("app.html");

const state = { channel: null, identifier: null };

function setMessage(el, tone, text) {
  el.dataset.tone = tone;
  el.textContent = text;
  el.hidden = false;
}
function clearMessage(el) {
  if (el) el.hidden = true;
}
function setLoading(btn, on) {
  btn.classList.toggle("is-loading", on);
  btn.disabled = on;
}

/* -- Step machine (identify → verify) -------------------------------------- */

const card = $(".auth-card");
const steps = {
  identify: $('[data-step="identify"]'),
  verify: $('[data-step="verify"]'),
};
const ORDER = ["identify", "verify"];
let currentName = "identify";

async function goToStep(name) {
  if (name === currentName) return;
  const cur = steps[currentName];
  const next = steps[name];
  card.dataset.activeStep = String(ORDER.indexOf(name) + 1);

  if (prefersReduced) {
    cur.hidden = true;
    cur.classList.remove("step--active");
    next.hidden = false;
    next.classList.add("step--active");
  } else {
    cur.classList.add("step--exit");
    await wait(150);
    cur.hidden = true;
    cur.classList.remove("step--active", "step--exit");
    next.hidden = false;
    next.classList.add("step--active");
  }
  currentName = name;
  onEnter(name, next);
}

function onEnter(name, el) {
  if (name === "verify") {
    otp.clear();
    startCountdown();
    $('[data-role="destination"]').textContent = maskDestination(
      state.channel,
      state.identifier
    );
  }
  const focusEl =
    el.querySelector("input:not([disabled])") || el.querySelector(".step__title");
  if (focusEl) focusEl.focus({ preventScroll: true });
}

/* -- Step 1: identify ------------------------------------------------------ */

const loginForm = $('[data-form="login"]');
const idInput = $("#identifier");
const idField = $('[data-field="identifier"]');
const idMsg = $("#login-msg");
const loginSubmit = $('[data-action="submit-login"]');

function detectChannel(value) {
  if (isValidEmail(value)) return "email";
  if (isValidPhone(value)) return "phone";
  return null;
}

idInput.addEventListener("input", () => {
  idField.classList.remove("is-invalid");
  clearMessage(idMsg);
  loginSubmit.disabled = idInput.value.trim() === "";
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = idInput.value.trim();
  const channel = detectChannel(raw);
  if (!channel) {
    idField.classList.add("is-invalid");
    setMessage(idMsg, "error", "Enter the phone number or email for your account.");
    return;
  }
  state.channel = channel;
  state.identifier = channel === "phone" ? normalizePhone(raw) : raw.toLowerCase();

  setLoading(loginSubmit, true);
  const res = await authService.startLogin({
    channel: state.channel,
    identifier: state.identifier,
  });
  setLoading(loginSubmit, false);

  if (res.ok) {
    goToStep("verify");
  } else if (res.code === "not_found") {
    idField.classList.add("is-invalid");
    setMessage(idMsg, "error", `${res.message} You can create one below.`);
  } else {
    idField.classList.add("is-invalid");
    setMessage(idMsg, "error", res.message ?? "Something went wrong.");
  }
});

/* -- Step 2: verify -------------------------------------------------------- */

const verifyForm = $('[data-form="verify"]');
const verifySubmit = $('[data-action="submit-verify"]');
const verifyMsg = $('[data-role="verify-message"]');
const resendBtn = $('[data-action="resend"]');
const resendLabel = $('[data-role="resend-label"]');

let verifying = false;
let timer = null;
const RESEND_SECONDS = 30;

const otp = createOtpInput($('[data-role="otp"]'), {
  length: 6,
  onChange: (v) => {
    verifySubmit.disabled = v.length !== 6 || !/^\d{6}$/.test(v);
    clearMessage(verifyMsg);
  },
  onComplete: () => submitVerify(),
});

function startCountdown() {
  clearInterval(timer);
  let remaining = RESEND_SECONDS;
  resendBtn.disabled = true;
  const render = () => {
    resendLabel.textContent = "You can resend the code in";
    resendBtn.textContent = `0:${String(remaining).padStart(2, "0")}`;
  };
  render();
  timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
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
  startCountdown();
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
    clearInterval(timer);
    location.replace("app.html");
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

/* -- Back + dev chip ------------------------------------------------------- */

$('[data-action="back"]').addEventListener("click", () => {
  if (currentName === "verify") goToStep("identify");
  else location.href = "index.html";
});

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

loginSubmit.disabled = true;
