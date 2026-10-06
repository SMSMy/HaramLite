/* ── ١-أ (حارس نصّي) · تسلسل init في main.ts: ping/setAppVersion قبل wire() ──
 *
 * **العيب المقيس بيدي** (مالك، 2026-10-05): اختبار `aboutVersionTruth`
 * يمثّل الترتيب الصحيح **داخل نفسه** (‏`setAppVersion` ثم `wireAbout`) ولا
 * يقرأ الكود — فأُعيد main.ts إلى الترتيب المعطوب (‏`wire()` قبل جلب `ping`)
 * ومرّ **3/3**. فلا شيء يمنع عودة `v—`.
 *
 * **المطلوب**: حارس يقرأ `main.ts` **نصّاً** (‏`?raw` — نمط
 * `dragClassFeedback.test.ts:22`) ويُثبت أن `invoke('ping')` و
 * `session.setAppVersion` **تسبقان** `wire()` في تسلسل `init()`.
 *
 * **المُفسِد**: إعادة ترتيب السطور في نسخة نصّية ⇒ يُسقط الفاحص (مقيس
 * أدناه على نسخة مقلوبة).
 */
import { describe, expect, it } from 'vitest';
import mainTs from '../main.ts?raw';

/** يُزيل التعليقات السطرية والكتلية — وإلا التقط الفحص `wire()` المذكور
 *  في تعليق فيسبق النداء الحقيقي (عطل قِيس وأُصلح). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** هل يسبق `ping`/`setAppVersion` نداء `wire()` في نصّ المصدر؟
 *  يُرجع `null` عند الصحة، وسبب الرفض عند الفشل — كي يُستعمل على نسخ
 *  مُعدَّلة (المُفسِد) وعلى الإنتاج بنفس الحرف. */
function checkInitOrder(raw: string): string | null {
  const src = stripComments(raw);
  // نطاق init: من أول `async function init` — تسلسل الإقلاع كله في أول 4000 حرف.
  const initAt = src.search(/(?:export\s+)?async function init\s*\(/);
  if (initAt < 0) return 'init() غائب من main.ts — الفحص باطل';
  const scope = src.slice(initAt, initAt + 4000);

  const pingAt = scope.search(/invoke(?:\s*<[^>]*>)?\s*\(\s*['"]ping['"]/);
  const setVerAt = scope.indexOf('session.setAppVersion');
  // النداء لا التعريف: `wire();` كسطر — لا `function wire()`.
  const wireAt = scope.search(/(?<!function\s)\bwire\s*\(\s*\)\s*;/);

  if (wireAt < 0) return 'نداء wire() غائب من نطاق init — الفحص باطل';
  if (pingAt < 0) return "invoke('ping') غائب من نطاق init — الفحص باطل";
  if (setVerAt < 0) return 'session.setAppVersion غائب من نطاق init — الفحص باطل';

  if (!(pingAt < wireAt)) {
    return `invoke('ping') عند ${pingAt} لا يسبق wire() عند ${wireAt} — fillAbout سيكتب v—`;
  }
  if (!(setVerAt < wireAt)) {
    return `session.setAppVersion عند ${setVerAt} لا يسبق wire() عند ${wireAt} — fillAbout سيكتب v—`;
  }
  return null;
}

/** نسخة مقلوبة: كتلة الجلب (try التي تحمل ping) تُنقل بعد wire() —
 *  وهو العطب المقيس حرفياً. لا يعتمد على نصّ تعليق. */
function mutateReorder(src: string): string {
  // أول try بعد applyLang هي كتلة الجلب في init (تسلسل الإقلاع).
  const applyLangAt = src.indexOf('applyLang()');
  expect(applyLangAt, 'applyLang غائب — الفحص باطل').toBeGreaterThan(-1);
  const blockStart = src.indexOf('try {', applyLangAt);
  expect(blockStart, 'كتلة try للجلب غائبة — الفحص باطل').toBeGreaterThan(-1);
  // نهاية الكتلة: أول `}` يقفل catch — نبحث عن `console.error` ثم السطر التالي.
  const catchEnd = src.indexOf('console.error(e);', blockStart);
  expect(catchEnd, 'catch غائب').toBeGreaterThan(-1);
  const blockEnd = src.indexOf('}', catchEnd) + 1;
  const block = src.slice(blockStart, blockEnd);
  expect(block, 'الكتلة لا تحمل ping — الفحص باطل').toContain("'ping'");

  const without = src.slice(0, blockStart) + src.slice(blockEnd);
  const wireMatch = without.match(/\bwire\s*\(\s*\)\s*;/);
  expect(wireMatch, 'wire() غائب بعد الحذف').not.toBeNull();
  const wireEnd = (wireMatch!.index ?? 0) + wireMatch![0].length;
  // المُفسِد: الكتلة **بعد** wire() — وهو العطب المقيس.
  return without.slice(0, wireEnd) + '\n  ' + block + without.slice(wireEnd);
}

describe('١-أ (حارس نصّي) · ping وsetAppVersion قبل wire() في main.ts', () => {
  it('main.ts الإنتاج يمرّ الفاحص', () => {
    expect(checkInitOrder(mainTs), 'main.ts الإنتاج: التسلسل معطوب').toBeNull();
  });

  it('المُفسِد: إعادة الترتيب (wire قبل الجلب) ⇒ الفاحص يرفض', () => {
    const mutated = mutateReorder(mainTs);
    const reason = checkInitOrder(mutated);
    expect(reason, 'الفاحص لم يلتقط إعادة الترتيب — الحارس عمياء').not.toBeNull();
    expect(reason).toMatch(/ping|setAppVersion/);
  });

  it('المُفسِد: wire() قبل ping وحده يكفي للرفض', () => {
    // نسخة مصغّرة: الترتيبان فقط — لا يعتمد على بنية main.ts الكاملة.
    const ok = `
      async function init() {
        const info = await invoke('ping');
        session.setAppVersion(info.version);
        wire();
      }`;
    const bad = `
      async function init() {
        wire();
        const info = await invoke('ping');
        session.setAppVersion(info.version);
      }`;
    expect(checkInitOrder(ok), 'الترتيب الصحيح يجب أن يمرّ').toBeNull();
    expect(checkInitOrder(bad), 'wire() أولًا يجب أن يُرفض').not.toBeNull();
  });

  it('الفاحص يرفض غياب أي طرف (لا فحص زائف)', () => {
    expect(checkInitOrder('async function init() { wire(); }')).toMatch(/ping|setAppVersion/);
    expect(
      checkInitOrder("async function init() { const i = await invoke('ping'); wire(); }"),
    ).toMatch(/setAppVersion/);
    expect(checkInitOrder('function other() { wire(); }')).toMatch(/init/);
  });
});
