import crypto from "crypto";

/**
 * Generates a cryptographically random, high-entropy temporary credential.
 *
 * Properties:
 * - 14 characters long
 * - Guarantees inclusion of uppercase, lowercase, numbers, and special symbols
 * - Generated using crypto.randomBytes and crypto.randomInt (CSPRNG)
 * - Immune to dictionary attacks and universal password reuse
 *
 * @returns {string} High-entropy temporary password
 */
export function generateSecureTemporaryCredential() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*";

  // Select at least one character from each set to guarantee complexity
  const chars = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  // Fill remaining 10 characters from the full character pool
  const allChars = upper + lower + digits + symbols;
  const randomBytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) {
    chars.push(allChars[randomBytes[i] % allChars.length]);
  }

  // Fisher-Yates shuffle using cryptographically secure random integers
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}
