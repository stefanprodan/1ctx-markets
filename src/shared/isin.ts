// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// ISO 6166 numbers: two letters, nine letters or digits, a check digit.

const SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

// the Luhn sum over the digits, a letter read as its two (A is 10)
export function isIsin(value: string): boolean {
  if (!SHAPE.test(value)) return false;
  const digits = [...value]
    .map((c) => (c >= "A" ? String(c.charCodeAt(0) - 55) : c))
    .join("");
  let sum = 0;
  for (let k = 0; k < digits.length; k++) {
    let d = Number(digits[digits.length - 1 - k]);
    if (k % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
