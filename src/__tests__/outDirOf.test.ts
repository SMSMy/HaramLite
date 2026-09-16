/* ── ج-١٠ (وحدة نقية ٢) — outDirOf() في src/media.ts:130 ──────────────────
 * outDirOf يشتقّ مجلد الإخراج من مسار الملف، ويستعمله الفصل والتنزيل وفتح
 * المجلد. الاختبار يثبّت حالاته الحقيقية على ويندوز (خلفي/أمامي/مختلط/مزدوج)
 * وعلى مسار يونيكود عربي، ويسجّل بصراحة الحالات التي يبدو فيها السلوك الحالي
 * غير مقصود (اسم ملف بلا مجلد · فاصل أخره · ملف في جذر القرص) بلا إصلاح.
 */
import { describe, expect, it } from 'vitest';
import { outDirOf } from '../media';

describe('ج-١٠ · outDirOf returns the folder that holds the file', () => {
  it.each([
    ['plain Windows path', 'C:\\Music\\Album\\track.mp3', 'C:\\Music\\Album'],
    ['forward slashes', 'C:/Music/Album/track.mp3', 'C:/Music/Album'],
    ['mixed separators', 'C:\\Music/Album\\track.mp3', 'C:\\Music/Album'],
    ['nested folders with spaces', 'C:\\My Music\\Album 2\\track 1.mp3', 'C:\\My Music\\Album 2'],
    ['Arabic unicode path', 'C:\\موسيقى\\أناشيد\\المقطع ١.mp3', 'C:\\موسيقى\\أناشيد'],
    ['no extension', 'C:\\Music\\Album\\track', 'C:\\Music\\Album'],
    ['dot-file name', 'C:\\Music\\Album\\.hidden', 'C:\\Music\\Album'],
    ['doubled separator collapses', 'C:\\Music\\\\track.mp3', 'C:\\Music'],
    ['mix of doubled separators', 'C:\\Music\\//track.mp3', 'C:\\Music'],
    ['UNC path', '\\\\server\\share\\track.mp3', '\\\\server\\share'],
    ['POSIX path', '/home/user/track.mp3', '/home/user'],
    ['name carrying markup (path data is not parsed)', 'C:\\موسيقى\\<img src=x>.mp3', 'C:\\موسيقى'],
  ])('%s', (_label, input, expected) => {
    expect(outDirOf(input)).toBe(expected);
  });
});

describe('ج-١٠ · outDirOf — CURRENT behaviour on the shapes it does not match', () => {
  // These pin what the function does today. They are NOT claims that the
  // behaviour is wanted; the first one is reported as a probable defect
  // (a drive-relative "C:" instead of "C:\\") and left unfixed on purpose.
  it('a file at the drive root loses the separator: "C:\\a.mp3" -> "C:"', () => {
    expect(outDirOf('C:\\a.mp3')).toBe('C:');
  });

  it('a bare file name is returned unchanged (no separator to cut)', () => {
    expect(outDirOf('track.mp3')).toBe('track.mp3');
  });

  it('a path ending in a separator is returned unchanged', () => {
    expect(outDirOf('C:\\Music\\Album\\')).toBe('C:\\Music\\Album\\');
    expect(outDirOf('\\\\server\\share\\')).toBe('\\\\server\\share\\');
  });
});
