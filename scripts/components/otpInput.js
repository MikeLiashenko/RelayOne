/**
 * RelayOne — OTP input
 *
 * A reusable 6-digit (configurable) verification-code input with:
 *   • auto-advance between digits
 *   • backspace to the previous digit
 *   • left/right arrow navigation
 *   • full-code paste distribution
 *   • error (shake) state
 *
 * Usage:
 *   const otp = createOtpInput(rootEl, { length: 6, onComplete, onChange });
 *   otp.value();        // "123456"
 *   otp.clear();        otp.focusFirst();
 *   otp.setError(true); otp.setEnabled(false);
 */
export function createOtpInput(root, options = {}) {
  const { length = 6, onComplete, onChange } = options;

  root.classList.add("otp");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${length}-digit verification code`);

  /** @type {HTMLInputElement[]} */
  const inputs = [];

  for (let i = 0; i < length; i += 1) {
    const input = document.createElement("input");
    input.className = "otp__digit";
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = i === 0 ? "one-time-code" : "off";
    input.setAttribute("aria-label", `Digit ${i + 1}`);
    input.maxLength = 1;
    inputs.push(input);
    root.appendChild(input);
  }

  const clearError = () => root.classList.remove("is-invalid", "is-shaking");

  const value = () => inputs.map((i) => i.value).join("");

  const emitChange = () => {
    const v = value();
    inputs.forEach((i) => i.setAttribute("data-filled", String(i.value !== "")));
    if (typeof onChange === "function") onChange(v);
    // A full value means every cell is filled: empty cells contribute nothing
    // to the join, so length === `length` can only hold when none are blank.
    if (v.length === length && /^\d+$/.test(v)) {
      if (typeof onComplete === "function") onComplete(v);
    }
  };

  const focusAt = (index) => {
    const el = inputs[Math.max(0, Math.min(index, length - 1))];
    el.focus();
    el.select();
  };

  function handleInput(index, event) {
    clearError();
    const digits = event.target.value.replace(/\D/g, "");

    if (digits.length === 0) {
      event.target.value = "";
      emitChange();
      return;
    }
    // Keep the last typed digit; overflow spills into following cells.
    const chars = digits.split("");
    let cursor = index;
    while (chars.length && cursor < length) {
      inputs[cursor].value = chars.shift();
      cursor += 1;
    }
    focusAt(cursor >= length ? length - 1 : cursor);
    emitChange();
  }

  function handleKeydown(index, event) {
    const input = inputs[index];
    if (event.key === "Backspace") {
      if (input.value === "" && index > 0) {
        event.preventDefault();
        inputs[index - 1].value = "";
        focusAt(index - 1);
        emitChange();
      } else {
        clearError();
      }
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "ArrowRight" && index < length - 1) {
      event.preventDefault();
      focusAt(index + 1);
    }
  }

  function handlePaste(event) {
    event.preventDefault();
    clearError();
    const text = (event.clipboardData || window.clipboardData).getData("text");
    const digits = text.replace(/\D/g, "").slice(0, length).split("");
    if (!digits.length) return;
    inputs.forEach((i) => (i.value = ""));
    digits.forEach((d, i) => (inputs[i].value = d));
    focusAt(Math.min(digits.length, length - 1));
    emitChange();
  }

  inputs.forEach((input, index) => {
    input.addEventListener("input", (e) => handleInput(index, e));
    input.addEventListener("keydown", (e) => handleKeydown(index, e));
    input.addEventListener("paste", handlePaste);
    input.addEventListener("focus", () => input.select());
  });

  return {
    value,
    clear() {
      inputs.forEach((i) => {
        i.value = "";
        i.removeAttribute("data-filled");
      });
      clearError();
    },
    focusFirst() {
      focusAt(0);
    },
    setEnabled(enabled) {
      inputs.forEach((i) => (i.disabled = !enabled));
    },
    setError(isError) {
      if (isError) {
        root.classList.add("is-invalid", "is-shaking");
        // Allow the shake animation to be re-triggered on the next error.
        setTimeout(() => root.classList.remove("is-shaking"), 420);
      } else {
        clearError();
      }
    },
    isComplete() {
      const v = value();
      return v.length === length && /^\d+$/.test(v);
    },
  };
}
