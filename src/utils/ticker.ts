// Israeli mutual funds and securities on the Tel Aviv Stock Exchange are
// commonly identified by a purely numeric code (e.g. "1159235") rather than
// a letter symbol. Yahoo Finance (and therefore our backend, which sources
// data from it) lists these under a ".TA" suffix, so numeric-only input is
// normalized to that format before being fetched or persisted. Anything
// that already contains letters or punctuation (including an already
// ".TA"-suffixed symbol picked from the search dropdown) is left alone.
const NUMERIC_ONLY_PATTERN = /^\d+$/;

export function normalizeTickerInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (NUMERIC_ONLY_PATTERN.test(trimmed)) {
    return `${trimmed}.TA`;
  }
  return trimmed.toUpperCase();
}
