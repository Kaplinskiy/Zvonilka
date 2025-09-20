import { readFileSync } from 'node:fs';

/**
 * Recursively collect translation keys from an object.
 * @param {object} obj - The JSON object to traverse.
 * @param {string} [prefix] - Key path prefix for nested keys.
 * @returns {string[]} - List of flattened key paths.
 */
function keys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? keys(v, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );
}

test('i18n keys are consistent across ru/en/he', () => {
  const ru = JSON.parse(readFileSync('public/i18n/ru.json', 'utf8'));
  const en = JSON.parse(readFileSync('public/i18n/en.json', 'utf8'));
  const he = JSON.parse(readFileSync('public/i18n/he.json', 'utf8'));

  const sru = new Set(keys(ru));
  const sen = new Set(keys(en));
  const she = new Set(keys(he));

  const diff = (a, b) => [...a].filter((k) => !b.has(k));

  const missing = {
    en_missing: diff(sru, sen),
    he_missing: diff(sru, she),
    ru_extra: [...diff(sen, sru), ...diff(she, sru)]
  };

  expect(missing).toEqual({ en_missing: [], he_missing: [], ru_extra: [] });
});