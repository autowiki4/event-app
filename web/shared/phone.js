/* Shared North American phone-number behavior.
 * Values sent to the backend stay as ten digits; formatting is display-only. */
const Phone = (() => {
  const MAX_DIGITS = 10;
  const boundInputs = new WeakSet();
  const overflowInputs = new WeakSet();

  function valueOf(value) {
    return value && typeof value === "object" && "value" in value ? value.value : value;
  }

  function allDigits(value) {
    return String(valueOf(value) || "").replace(/\D/g, "");
  }

  function digits(value) {
    return allDigits(value).slice(0, MAX_DIGITS);
  }

  function isValid(value) {
    if (value && typeof value === "object" && overflowInputs.has(value)) return false;
    return allDigits(value).length === MAX_DIGITS;
  }

  function formatInput(value) {
    const valueDigits = digits(value);
    if (!valueDigits) return "";
    if (valueDigits.length <= 3) return `(${valueDigits}`;
    if (valueDigits.length <= 6) {
      return `(${valueDigits.slice(0, 3)}) ${valueDigits.slice(3)}`;
    }
    return `(${valueDigits.slice(0, 3)}) ${valueDigits.slice(3, 6)}-${valueDigits.slice(6)}`;
  }

  function formatDisplay(value) {
    return isValid(value) ? formatInput(value) : String(value || "");
  }

  function cursorAfterDigits(formattedValue, digitCount) {
    if (digitCount <= 0) return formattedValue ? 1 : 0;
    let digitsSeen = 0;
    for (let index = 0; index < formattedValue.length; index += 1) {
      if (/\d/.test(formattedValue[index])) digitsSeen += 1;
      if (digitsSeen === digitCount) return index + 1;
    }
    return formattedValue.length;
  }

  function bind(input) {
    if (!input || boundInputs.has(input)) return;
    boundInputs.add(input);
    input.maxLength = 14;
    input.inputMode = "numeric";

    function applyFormatting() {
      const cursor = typeof input.selectionStart === "number" ? input.selectionStart : null;
      const digitsBeforeCursor = cursor === null ? null : allDigits(input.value.slice(0, cursor)).length;
      const enteredDigits = allDigits(input.value);
      if (enteredDigits.length > MAX_DIGITS) overflowInputs.add(input);
      else overflowInputs.delete(input);
      input.value = formatInput(enteredDigits);
      if (digitsBeforeCursor !== null && typeof input.setSelectionRange === "function") {
        const nextCursor = cursorAfterDigits(input.value, digitsBeforeCursor);
        input.setSelectionRange(nextCursor, nextCursor);
      }
      if (typeof input.setCustomValidity === "function") {
        input.setCustomValidity(overflowInputs.has(input) ? "Enter a 10-digit phone number." : "");
      }
    }

    applyFormatting();
    input.addEventListener("input", applyFormatting);
  }

  return { digits, isValid, formatInput, formatDisplay, bind };
})();
