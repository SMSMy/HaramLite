/* ── ج-١٠ (وحدة نقية ١) — sanitizePath() وfileBaseName() في src/util.ts ────
 * sanitizePath هو جذر B1/B2: كل مسار ملصوق أو مُسحوب يمرّ منه قبل أي نداء
 * للخلفية، فسطر واحد فيه يحكم على ما يصل إلى Rust. الاختبار يثبّت ما يغيّره
 * (تشذيب الأطراف + زوج اقتباسات واحد من "Copy as path") وما لا يجوز أن يغيّره
 * (الشرطات المائلة المزدوجة، اليونيكود العربي، الاقتباسات الداخلية).
 */
import { describe, expect, it } from 'vitest';
import { fileBaseName, sanitizePath } from '../util';

describe('ج-١٠ · sanitizePath keeps a real path intact', () => {
  const preserved: [string, string][] = [
    ['plain Windows path', 'C:\\Music\\track.mp3'],
    ['forward slashes', 'C:/Music/track.mp3'],
    ['mixed separators', 'C:\\Music/Album\\track.mp3'],
    ['folder path with no extension', 'C:\\Music\\Album'],
    ['nested folders with spaces', 'C:\\My Music\\Album 2\\track 1.mp3'],
    ['Arabic unicode path', 'C:\\موسيقى\\أناشيد\\المقطع ١.mp3'],
    ['doubled backslash inside the path', 'C:\\Music\\\\track.mp3'],
    ['doubled forward slash', 'C://Music//track.mp3'],
    ['UNC path', '\\\\server\\share\\track.mp3'],
    ['extra dot in the name', 'C:\\Music\\track.final.mp3'],
  ];

  it.each(preserved)('%s is returned verbatim', (_label, input) => {
    expect(sanitizePath(input)).toBe(input);
  });
});

describe('ج-١٠ · sanitizePath removes only the wrappers it means to remove', () => {
  const rewritten: [string, string, string][] = [
    ['trims surrounding whitespace', '  C:\\Music\\track.mp3 \t', 'C:\\Music\\track.mp3'],
    ['trims newlines', '\nC:\\Music\\track.mp3\r\n', 'C:\\Music\\track.mp3'],
    [
      'strips the Explorer "Copy as path" quote pair',
      '"C:\\My Music\\track.mp3"',
      'C:\\My Music\\track.mp3',
    ],
    ['trims padding inside the quotes', '" C:\\Music\\track.mp3 "', 'C:\\Music\\track.mp3'],
    ['trims padding outside the quotes', '  "C:\\Music\\track.mp3"  ', 'C:\\Music\\track.mp3'],
    ['strips exactly one pair, not two', '""C:\\Music\\track.mp3""', '"C:\\Music\\track.mp3"'],
    ['whitespace only becomes empty', '   \t ', ''],
    ['an empty string stays empty', '', ''],
    ['a pair of quotes becomes empty', '""', ''],
  ];

  it.each(rewritten)('%s', (_label, input, expected) => {
    expect(sanitizePath(input)).toBe(expected);
  });

  const untouched: [string, string][] = [
    ['a lone double quote (needs a pair to strip)', '"'],
    ['an unbalanced leading quote', '"C:\\Music\\track.mp3'],
    ['an unbalanced trailing quote', 'C:\\Music\\track.mp3"'],
    ['single quotes are not stripped', "'C:\\Music\\track.mp3'"],
    ['a double quote inside the name', 'C:\\Music\\tr"ack.mp3'],
    ['a quoted suffix that is not a wrapper', '"C:\\Music"\\track.mp3'],
  ];

  it.each(untouched)('%s is left as it is', (_label, input) => {
    expect(sanitizePath(input)).toBe(input);
  });

  it('does not touch the file system view of the path (no normalization)', () => {
    // Guard against a "helpful" rewrite: sanitizePath must not resolve `..`,
    // collapse separators or drop a trailing separator on its own.
    expect(sanitizePath('C:\\Music\\..\\Album\\track.mp3')).toBe('C:\\Music\\..\\Album\\track.mp3');
    expect(sanitizePath('C:\\Music\\Album\\')).toBe('C:\\Music\\Album\\');
  });
});

describe('ج-١٠ · fileBaseName()', () => {
  it.each([
    ['backslash path', 'C:\\a\\b\\c.mp3', 'c.mp3'],
    ['forward-slash path', 'C:/a/b/c.mp3', 'c.mp3'],
    ['bare file name', 'c.mp3', 'c.mp3'],
    ['Arabic unicode name', 'C:\\موسيقى\\المقطع ١.mp3', 'المقطع ١.mp3'],
    ['name with spaces', 'C:\\My Music\\track 1.mp3', 'track 1.mp3'],
    // CURRENT behaviour (not asserted as desirable): a trailing separator
    // yields an empty base name. Reported, not fixed — see the 0.2.7 report.
    ['trailing separator (current behaviour: empty)', 'C:\\a\\b\\', ''],
  ])('%s', (_label, input, expected) => {
    expect(fileBaseName(input)).toBe(expected);
  });
});
