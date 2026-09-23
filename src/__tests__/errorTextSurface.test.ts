/* ── ط-٤ · نصّ خطأ الخلفية في واجهة بلغة أخرى: الحارس البنيوي والقياس الحيّ ────
 *
 * **العطل** (بند ط-٤ في `docs/BACKLOG-0.3.md`): التطبيق يصوغ أخطاءه بالعربية،
 * وكانت `src/integration.ts:695,704` تعرض `payload.error` **خاماً** ⇒ من واجهته
 * إنجليزية يرى نصّاً عربياً بلا ترجمة. وهو **نفس صنف عطل م٦-ج** في الإضافة —
 * أُغلق هناك (رمز مستقرّ `code` + جدول ترجمة) و**بقي في واجهة التطبيق**.
 *
 * **ما يقيسه هذا الملف — أربعة أقسام، ولا واحد منها يغني عن الآخر**:
 *   ① **`errText` وحدها**: سلوك الدالّة على الحمولات الأربع (رمز معلوم · رمز
 *      مجهول · بلا رمز · ليست حمولة). وهذا **قياس وحدة**.
 *   ② **المسار الحيّ**: يوقظ مستمع `bridge-done` **الحقيقي** في `wireBridge()`
 *      على DOM التطبيق (`index.html`) بلغة `en`، ويسأل عمّا كُتب في `#toast`
 *      و`#bridge-card-text` فعلاً. وهذا **قياس سلوكيّ** لا ساكن.
 *   ③ **الحارس البنيوي** (النمط المطلوب، مأخوذ من `scripts/check-bridge-codes.cjs`):
 *      **لا قراءة `.error`/`.message` في `src/**` خارج `errText`** إلا بما هو
 *      **مُعلَن بالاسم والعدد والتعليل** في `RAW_READS` أدناه — وقراءةٌ جديدة،
 *      أو زيادةٌ في عدد قائم، أو **نقصان** عنه ⇒ سقوط مسمّى بموضعه.
 *   ④ **تقابل الرموز في الاتجاهين**: كل `pub const E_*` في `src-tauri/src/bridge.rs`
 *      له مدخل `code.<قيمته>` في `i18n.ar` **و**`i18n.en` — والعكس. فرمزٌ جديد
 *      في الرست بلا مدخل = نصّ عربي يعود إلى واجهة إنجليزية **صامتاً** (العطل
 *      نفسه من بابه الثاني)، ومدخل بلا رمز = تغطية وهمية.
 *
 * **وحدوده المعلَنة — ما لا يقيسه**:
 *   • **العدّ جارف** (يشمل ما وقع داخل نصّ حرفيّ أو تعبير) عمداً: الجارف لا
 *     يُفلت قراءة حقيقية، والزائد **يُسمّى بموضعه** فيُعلَن أو يُزال.
 *   • الحارس البنيوي **نصّي لا برهان**: قراءةٌ ملتوية (اسم مستعار، أو تمرير
 *     خطأ عبر وسيط بلا قراءة ظاهرة) لا يراها. حدّه أنه يمنع **تكرار العطل
 *     بالطريقة التي وقع بها**، لا كل صوره.
 *   • **قراءات التشخيص مُعلَنة لا مُصلَحة**: `push_log` والسجلّ و`console.error`
 *     تبقى بالنصّ الخام (الخام أنفع في التشخيص)، وكذلك `code.engine_error` الذي
 *     يُبقي تفصيل المحرّك بلغته بعد الجملة المترجَمة — **وهو بند ط-١٢ المفتوح**.
 *   • **`queue.ts:1133` ليس من هذا الباب**: `update_ytdlp` يعيد حقل `message`
 *     **حالةً لا خطأ** (‏`src-tauri/src/yt_dlp.rs:684-705` نصوصه عربية: «لم يحن
 *     موعد فحص التحديث» · «yt-dlp محدّث بالفعل») ولا `code` في عقده ⇒ **لم
 *     يُصلَح هنا** (يحتاج عقداً في الرست خارج نطاق هذا العامل) وهو **مُبلَّغ عنه**.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => null),
  listeners: new Map<string, (ev: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (ev: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return () => {};
  }),
}));

/* ══ ③ الحارس البنيوي: لا قراءة خامّة خارج `errText` ═══════════════════════ */

/** دالّة واحدة — وهي الموضع الوحيد المسموح له بقراءة `.error`. */
const SANCTIONED_FNS = ['errText'];

/** قراءة حقل خطأ: `.error` أو `.message` — والعدّ **جارف**.
 *  ويُستثنى ما يتبعه قوس (`console.error(`) لأنه **استدعاء دالّة** لا قراءة حقل.
 *  (وهذا التعبير بعينه هو المستعمل في `scripts/check-bridge-codes.cjs`، فالقاعدتان
 *  واحدة في السطحين — لا نسختان تفترقان.) */
const RAW_READ_RE = /\.\s*(?:error|message)\b(?!\s*\()/g;

/** جذر المستودع — **بـ`fileURLToPath` لا بـ`new URL('..', import.meta.url)`**.
 *
 * **فخّ مقيس**: `vite:asset-import-meta-url` يعيد كتابة `new URL('<نصّ حرفيّ>',
 * import.meta.url)` إلى رابط أصل يخدمه خادم التطوير ⇒ يعود `http://localhost:3000/@fs/…`
 * ويرفضه `node:fs` بـ`ERR_INVALID_URL_SCHEME: The URL must be of scheme file`.
 * (قِيس هنا: `new URL('../../', import.meta.url).href` = `http://localhost:3000/@fs/C:/…`.)
 * و`fileURLToPath` لا يُعاد كتابته، فالمسار يبقى `file:` كما يجب. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * **القراءات الخام المُعلَنة بالاسم والعدد والتعليل** — وكلها **ليست عرضاً
 * لمستخدم** إلا ما نُصّ على خلافه. وقراءةٌ جديدة (أو زيادة/نقصان في عدد قائم)
 * تُسقط الحارس: البديل الصحيح لمن كتب عرضاً جديداً أن يمرّره بـ`errText`.
 *
 * والاختيار **جارف** عمداً كما في حارس الإضافة: الجارف لا يُفلت قراءة حقيقية،
 * والزائد يُسمّى بموضعه فيُعلَن أو يُزال — بخلاف عدّ يحتاج تجريد النصوص فيُخفي
 * ما فيه.
 */
const RAW_READS: Array<{ file: string; n: number; re: RegExp; why: string }> = [
  {
    file: 'aboutUpdate.ts', n: 2, re: /\bst\.error\b/,
    why: 'بوابة وجود (`if (st.error)`) + سطر سجلّ — والعرض نفسه يمرّ بـ`errText(st)` في الفرعين أعلاه',
  },
  {
    file: 'integration.ts', n: 1, re: /id\.error\b/,
    why: 'بوابة وجود تقرّر الحالة `error` في `identityVerdict` — لا تُعرض؛ والعرض في `errText(id)`',
  },
  {
    file: 'integration.ts', n: 1, re: /console\.error\)/,
    why: 'مرجع دالّة يُمرَّر إلى `.catch()` (لا قراءة حقل) — ويُطابق النمط الجارف',
  },
  {
    file: 'jobs.ts', n: 1, re: /reg\.error\b/,
    why: 'تمرير قيمة **سبق أن مرّت بـ`errText`** في `fetchActiveJobs` (لا قراءة جديدة للخام)',
  },
  {
    file: 'jobs.ts', n: 2, re: /outcome\.error\b/,
    why: 'مثل أعلاه: القيمة من `registry-error`/`cancel-error` وقد مرّت بـ`errText` عند الحدّ',
  },
  {
    file: 'log.ts', n: 1, re: /line\.message\b/,
    why: 'لوحة السجلّ: حقل `message` لسطر سجلّ من الخلف — **سطح تشخيص** لا رسالة خطأ مُصاغة',
  },
  {
    file: 'main.ts', n: 1, re: /ev\.message\b/,
    why: 'خطأ JavaScript في الصفحة نفسها (`window.onerror`) ⇒ يُسجَّل؛ لا نصّ خلفية',
  },
  {
    file: 'player.ts', n: 1, re: /console\.error\)/,
    why: 'مرجع دالّة في `.catch()` (لا قراءة حقل)',
  },
  {
    file: 'queue.ts', n: 2, re: /console\.error\)/,
    why: 'مرجعا دالّة في `.catch()` لزرّي «افتح الملف/المجلد» (لا قراءة حقل)',
  },
  {
    file: 'queue.ts', n: 3, re: /reg\.error\b/,
    why: 'سطر سجلّ + مقارنة تغيير (`lastJobsError !== reg.error`) — والقيمة مرّت بـ`errText`',
  },
  {
    file: 'queue.ts', n: 1, re: /r\.message\b/,
    why: '**حقل حالة لا خطأ**: `update_ytdlp` يعيد `message` عربيّاً بلا `code` (بند مُبلَّغ عنه، خارج ط-٤)',
  },
  {
    file: 'settingsPanel.ts', n: 1, re: /payload\.error\b/,
    why: 'سطر سجلّ — والعرض في السطر نفسه صار `errText(ev.payload) || t(...)`',
  },
  {
    file: 'watch.ts', n: 1, re: /p\.error\b/,
    why: 'سطر سجلّ لملف مراقَب (`push_log`) — لا سطح عرض',
  },
];

/** تحييد التعليقات **بمسافات** (الأسطر كما هي) حتى لا يُقاس كلامٌ في تعليق.
 *  والنصوص الحرفية **تبقى** عمداً: العدّ جارف (انظر حدّ الحارس أعلاه). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < src.length) { out += '  '; i += 2; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** مدى جسم دالّة في نصّ JS: `[بداية القوس, نهايته)` — بتجاوز النصوص. */
function fnSpan(text: string, name: string): { start: number; end: number } | null {
  const at = new RegExp('function\\s+' + name + '\\s*\\(').exec(text);
  if (!at) return null;
  const open = text.indexOf('{', at.index);
  if (open < 0) return null;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start: open, end: i }; }
    i++;
  }
  return null;
}

function lineOf(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** ملفات التشغيل: `src/*.ts` بلا `__tests__` (الحارس لا يقيس نفسه). */
function runtimeFiles(): string[] {
  return readdirSync(join(ROOT, 'src'), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => d.name)
    .sort();
}

const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('ط-٤ · لا قراءة `.error`/`.message` خامّة خارج `errText`', () => {
  const files = runtimeFiles();

  it('القياس ليس باطلاً: الملفات والدالّة المصرَّح بها موجودة', () => {
    // صفر مدخل: لولا هذا لمرّ الحارس لأنه لم ينظر (لا ملفات ⇒ صفر قراءة).
    expect(files.length, 'ملفات `src/*.ts` المقروءة').toBeGreaterThanOrEqual(10);
    const withFn = files.filter((f) => fnSpan(stripComments(readSrc('src/' + f)), 'errText'));
    expect(withFn, 'الدالّة المصرَّح بها `errText`').toEqual(['i18n.ts']);
  });

  it('كل قراءة خارجها مُعلَنة بالاسم والعدد — والعدد مطابق في الاتجاهين', () => {
    const declaredFor = (f: string) => RAW_READS.filter((d) => d.file === f);
    const unmatched: string[] = [];
    const counts = new Map(RAW_READS.map((d) => [d, 0]));
    let outside = 0;

    for (const f of files) {
      const raw = readSrc('src/' + f);
      const noCom = stripComments(raw);
      const spans = SANCTIONED_FNS
        .map((n) => fnSpan(noCom, n))
        .filter((s): s is { start: number; end: number } => s !== null)
        .map((s) => [s.start, s.end] as const);
      for (const m of noCom.matchAll(RAW_READ_RE)) {
        if (spans.some(([a, b]) => m.index > a && m.index < b)) continue;
        outside += 1;
        const window = noCom.slice(Math.max(0, m.index - 60), m.index + 60);
        const d = declaredFor(f).find((x) => x.re.test(window));
        const ctx = raw.slice(Math.max(0, m.index - 40), m.index + 26).replace(/\s+/g, ' ');
        if (!d) unmatched.push(`${f}:${lineOf(raw, m.index)} — «…${ctx}…»`);
        else counts.set(d, (counts.get(d) ?? 0) + 1);
      }
    }

    const wrong = [...counts.entries()]
      .filter(([d, n]) => n !== d.n)
      .map(([d, n]) => `${d.file} ${d.re} — المتوقَّع ${d.n} ووُجد ${n}`);

    expect(unmatched, 'قراءات غير مُعلَنة (مرّرها بـ`errText` أو أعلِنها باسمها وعددها وتعليلها)')
      .toEqual([]);
    expect(wrong, 'إعلان لا يطابق الواقع (زيادة أو نقصان ⇒ الإعلان باطل)').toEqual([]);
    // وقراءةٌ واحدة على الأقل خارج الدالّة مُعلَنة — وإلا فالإعلانات كلها صفرية
    // (وهي حالة مشروعة لكن يجب أن تكون **مقصودة**، فيُقاس العدد لا يُفترض).
    expect(outside, 'القراءات خارج `errText` (كلها مُعلَنة)').toBe(18);
  });

  it('و`errText` نفسها تقرأ الخام مرة واحدة — لا مرتين ولا في دالّة ثانية', () => {
    const i18nSrc = stripComments(readSrc('src/i18n.ts'));
    const span = fnSpan(i18nSrc, 'errText');
    expect(span, 'مدى `errText`').not.toBeNull();
    const reads = [...i18nSrc.slice(span!.start, span!.end).matchAll(RAW_READ_RE)].length;
    expect(reads, 'قراءات `.error`/`.message` داخل `errText`').toBe(1);
  });
});

/* ══ ④ تقابل الرموز: الرست ⇄ جدول الواجهة (الاتجاهان) ═══════════════════════ */

describe('ط-٤ · رموز `bridge.rs` لكلٍّ مدخل `code.*` في الجدولين', () => {
  const bridge = readSrc('src-tauri/src/bridge.rs');
  const declared = [...bridge.matchAll(/pub const E_[A-Z0-9_]+\s*:\s*&str\s*=\s*"([^"]+)";/g)]
    .map((m) => m[1]);

  it('القياس ليس باطلاً: الرست يُعلن رموزاً، والجدول يحمل مدخلات', async () => {
    const { i18n } = await import('../i18n');
    const tableCodes = (Object.keys(i18n.ar) as string[]).filter((k) => k.startsWith('code.'));
    expect(declared.length, 'ثوابت `E_*` في bridge.rs').toBeGreaterThanOrEqual(7);
    expect(tableCodes.length, 'مدخلات `code.*` في i18n.ar').toBeGreaterThanOrEqual(7);
    // ولا قيمة مكرّرة بين ثابتين (وإلا فمدخل واحد يخدم رمزين).
    expect(new Set(declared).size, 'قيم الرموز المعلَنة').toBe(declared.length);
  });

  it('لكل رمز مُصدَر مدخل — ولا مدخل بلا رمز (مدخل ميت = سقوط)', async () => {
    const { i18n } = await import('../i18n');
    const codesOf = (row: Record<string, unknown>) =>
      Object.keys(row).filter((k) => /^code\.[a-z][a-z0-9_]*$/.test(k)).map((k) => k.slice(5));
    const ar = codesOf(i18n.ar as unknown as Record<string, unknown>);
    const en = codesOf(i18n.en as unknown as Record<string, unknown>);
    const missing = declared.filter((c) => !ar.includes(c));
    const dead = ar.filter((c) => !declared.includes(c));
    expect(missing, 'رموز في الرست بلا مدخل في `i18n.ar` (نصّ عربي يعود صامتاً)').toEqual([]);
    expect(dead, 'مدخل في الجدول بلا رمز في الرست (تغطية وهمية)').toEqual([]);
    expect(ar, 'المدخلات في اللغتين').toEqual(en);
    for (const c of ar) {
      const row = i18n.ar as unknown as Record<string, string>;
      expect(row[`code.${c}`].trim(), `قيمة \`code.${c}\` في ar`).not.toBe('');
      expect((i18n.en as unknown as Record<string, string>)[`code.${c}`].trim(),
        `قيمة \`code.${c}\` في en`).not.toBe('');
    }
  });
});

/* ══ ① الوحدة: `errText` على الحمولات الأربع ════════════════════════════════ */

/** النصّ العربي الذي يصوغه التطبيق فعلاً في هذا المسار (`bridge.rs:1255`
 *  يمرّر `e.to_string()` من المحرّك). */
const AR_DETAIL = 'خطأ استدلال النموذج: تم إلغاء المعالجة من قبل المستخدم.';

describe('ط-٤ · `errText`: الرمز أولاً، والخام كما هو عند الجهل به', () => {
  it('حمولة فشل عربية + واجهة إنجليزية: يظهر النصّ الإنجليزي', async () => {
    vi.resetModules();
    localStorage.setItem('hl.lang', 'en');
    const { errText, i18n } = await import('../i18n');

    const out = errText({ ok: false, error: AR_DETAIL, code: 'internal_error' });
    expect(out, 'النصّ المعروض').toBe(i18n.en['code.internal_error']);
    expect(out, 'لا نصّ عربي').not.toContain('خطأ');
    expect(out).not.toBe(AR_DETAIL);
  });

  it('و`{e}` يحفظ تفصيل المحرّك بعد الجملة المترجَمة (الحدّ المعلَن · ط-١٢)', async () => {
    vi.resetModules();
    localStorage.setItem('hl.lang', 'en');
    const { errText, i18n } = await import('../i18n');

    const out = errText({ error: AR_DETAIL, code: 'engine_error' });
    expect(out).toBe(i18n.en['code.engine_error'].replace('{e}', AR_DETAIL));
    expect(out, 'الجملة بالإنجليزية').toContain('Engine failed');
    expect(out, 'والتفصيل لم يُفقد').toContain(AR_DETAIL);
  });

  it('ضابط ١: حمولة **بلا رمز** (تطبيق أقدم) ⇒ النصّ الخام حرفياً', async () => {
    vi.resetModules();
    localStorage.setItem('hl.lang', 'en');
    const { errText } = await import('../i18n');

    expect(errText({ ok: false, error: AR_DETAIL })).toBe(AR_DETAIL);
    expect(errText(new Error(AR_DETAIL))).toBe(`Error: ${AR_DETAIL}`);
    expect(errText(AR_DETAIL)).toBe(AR_DETAIL);
  });

  it('ضابط ٢: رمز **مجهول** لا يُترجَم تخميناً ⇒ النصّ الخام حرفياً', async () => {
    vi.resetModules();
    localStorage.setItem('hl.lang', 'en');
    const { errText } = await import('../i18n');

    expect(errText({ error: AR_DETAIL, code: 'future_probe_code' })).toBe(AR_DETAIL);
    // ولا يُقرأ من `Object.prototype` (رمزٌ اسمه `constructor` ليس مدخلاً).
    expect(errText({ error: AR_DETAIL, code: 'constructor' })).toBe(AR_DETAIL);
  });

  it('ضابط ٣: حمولة بحقل error فارغ تعطي نصّاً فارغاً — دلالة `String(p.error ?? "")`', async () => {
    vi.resetModules();
    const { errText } = await import('../i18n');

    expect(errText({ error: null })).toBe('');
    expect(errText({ error: undefined })).toBe('');
    expect(errText({ ok: false, error: '' })).toBe('');

    // **فرق سلوكي مُعلَن**: كائن **بلا حقل `error`** ليس حمولة خطأ، فيُعامَل
    // كأي قيمة مُرماة ⇒ `String(err)` (كما كان `String(e)` في كل مسارات
    // `catch`). والسلوك القديم في موضعَي الجسر وحدهما كان `String(p.error ?? '')`
    // أي `''`. **وتلك الحالة لا تقع في الإنتاج**: `err_last` (`bridge.rs:375`)
    // يُصدر `error` في كل حمولة فشل، والفرع الناجح لا ينادي `errText` أصلاً —
    // والاختيار مقصود: `String(err)` **لا يُخفي** خطأً لا نعرف حقله بدل أن
    // يُعرض فراغاً.
    const payload = { name: 'x', ok: false };
    expect(errText(payload)).toBe(String(payload));
  });

  it('وبالعربية: الجملة العربية تبقى كما هي (لا انحدار على قارئ العربية)', async () => {
    vi.resetModules();
    localStorage.setItem('hl.lang', 'ar');
    const { errText, i18n } = await import('../i18n');

    expect(errText({ error: AR_DETAIL, code: 'internal_error' }))
      .toBe(i18n.ar['code.internal_error']);
    expect(errText({ error: AR_DETAIL })).toBe(AR_DETAIL);
  });
});

/* ══ ② المسار الحيّ: مستمع `bridge-done` الحقيقي على DOM التطبيق ════════════ */

describe('ط-٤ · حمولة `bridge-done` حيّة: ما كُتب في الشاشة فعلاً', () => {
  const mountApp = (): void => {
    document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
  };
  const toast = (): string => document.getElementById('toast')?.textContent ?? '';
  const card = (): string => document.getElementById('bridge-card-text')?.textContent ?? '';

  beforeEach(() => {
    h.listeners.clear();
    h.invoke.mockImplementation(async () => null);
    mountApp();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.resetModules();
  });

  /** جذر نظيف بلغة القارئ، ثم يوقظ **مستمع الإنتاج** لـ`bridge-done`. */
  async function bootAndEmit(lang: 'ar' | 'en', payload: Record<string, unknown>): Promise<void> {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('hl.lang', lang);
    const integration = await import('../integration');
    integration.wireBridge();
    const cb = h.listeners.get('bridge-done');
    expect(cb, 'مستمع `bridge-done` سُجِّل فعلاً').toBeTruthy();
    cb!({ payload: { name: 'yt: probe', ok: false, ...payload } });
  }

  it('بالإنجليزية ورمز معلوم ⇒ الشاشة إنجليزية (لا النصّ العربي)', async () => {
    await bootAndEmit('en', { error: AR_DETAIL, code: 'internal_error' });
    expect(toast(), 'الإشعار').toContain('Internal error');
    expect(toast(), 'لا النصّ العربي الخام').not.toContain('خطأ استدلال');
    expect(card(), 'بطاقة الاكتمال').toContain('Internal error');
    expect(card()).not.toContain('خطأ استدلال');
  });

  it('ضابط: بلا رمز ⇒ النصّ الخام حرفياً في الشاشة (توافق خلفي)', async () => {
    await bootAndEmit('en', { error: AR_DETAIL });
    expect(toast(), 'الإشعار').toContain(AR_DETAIL);
    expect(toast()).not.toContain('Internal error');
    expect(card()).toContain(AR_DETAIL);
  });

  it('وبالعربية ورمز معلوم ⇒ الجملة العربية من الجدول', async () => {
    await bootAndEmit('ar', { error: AR_DETAIL, code: 'internal_error' });
    expect(toast()).toContain('عطل داخلي');
    expect(toast()).not.toContain('خطأ استدلال');
  });

  it('و`engine_error` يبقي التفصيل بعد الجملة المترجَمة (الحدّ المعلَن)', async () => {
    await bootAndEmit('en', { error: AR_DETAIL, code: 'engine_error' });
    expect(toast()).toContain('Engine failed');
    expect(toast(), 'التفصيل لم يُفقد').toContain(AR_DETAIL);
  });
});

/* ══ ⑤ الحارس يرى الخطأ: مُفسَداته (لا «حارس لم يسقط قط») ═══════════════════
 *
 * الحارس البنيوي أعلاه يقرأ **الملفات المشحونة**. وهذه الحالات تُشغّل **المقياس
 * نفسه** على نسخة معدَّلة في الذاكرة، فتُثبت أنه يرى الخطأ لا أنه مرّ لأنه لم
 * ينظر. (نظير `--selfcheck` في `scripts/check-bridge-codes.cjs`.)
 */
describe('ط-٤ · الحارس يرى الخطأ (مُفسَدات على المقياس نفسه)', () => {
  /** إعادة تمثيل عدّ الحارس على مجموعة ملفات مُمرَّرة — بلا قرص. */
  function countOutside(files: Record<string, string>): string[] {
    const out: string[] = [];
    for (const [f, raw] of Object.entries(files)) {
      const noCom = stripComments(raw);
      const spans = SANCTIONED_FNS
        .map((n) => fnSpan(noCom, n))
        .filter((s): s is { start: number; end: number } => s !== null)
        .map((s) => [s.start, s.end] as const);
      for (const m of noCom.matchAll(RAW_READ_RE)) {
        if (spans.some(([a, b]) => m.index > a && m.index < b)) continue;
        const window = noCom.slice(Math.max(0, m.index - 60), m.index + 60);
        const d = RAW_READS.filter((x) => x.file === f).find((x) => x.re.test(window));
        if (!d) out.push(`${f}:${lineOf(raw, m.index)}`);
      }
    }
    return out;
  }

  it('مُفسَد (أ): عرضٌ جديد يقرأ `.error` خامّاً ⇒ يسقط بموضعه', () => {
    const bad = countOutside({
      'integration.ts': 'export function show(p: { error?: string }) {\n  toast(String(p.error));\n}\n',
    });
    expect(bad, 'قراءة غير مُعلَنة').toEqual(['integration.ts:2']);
  });

  it('مُفسَد (ب): حذف الإعلان/تضييق نطاقه ⇒ القراءة القائمة تصير غير مُعلَنة', () => {
    const shipped = readSrc('src/watch.ts');
    expect(countOutside({ 'watch.ts': shipped }), 'الشجرة المشحونة').toEqual([]);
    // نُزيل الإعلان من القائمة (كما لو حذفه كاتب) ونعيد العدّ نفسه:
    const saved = RAW_READS.splice(RAW_READS.findIndex((d) => d.file === 'watch.ts'), 1);
    try {
      expect(countOutside({ 'watch.ts': shipped }), 'بعد إزالة الإعلان')
        .toEqual(['watch.ts:102']);
    } finally {
      RAW_READS.push(...saved);
    }
  });

  it('مُفسَد (ج): تحييد `errText` (إزالة جسمها) ⇒ قراءتها تصير «خارج» المصرَّح', () => {
    const real = readSrc('src/i18n.ts');
    const gutted = real.replace('export function errText(err: unknown): string {',
      'export function errText(err: unknown): string { void err; return ""; }\nfunction _unused(errTextBody: unknown) {');
    expect(gutted, 'الاستبدال وقع فعلاً').not.toBe(real);
    const hits = countOutside({ 'i18n.ts': gutted });
    expect(hits.length, 'قراءة `.error` خرجت من المدى المصرَّح').toBeGreaterThan(0);
  });
});
