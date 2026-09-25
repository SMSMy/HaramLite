/* ── ط-٤ · «لا مفتاح بلا مستهلك» + «لا عربية على سطح إنجليزي» ────────────────
 *
 * **العطل الذي وُلدت له** (بند الحُزَم): مفتاح ترجمة يبقى في الجدول بعد أن يزول
 * آخر قارئ له. وهو **لا يُكسر شيئاً فيُرى**: لا `tsc` تشتكي (المفتاح معرَّف
 * وليس مطلوباً)، ولا اختبار يسقط، ولا مستخدم يرى فرقاً — فيبقى **تغطيةً
 * وهمية**: من يقرأ الجدول يحسب النصّ مغطّى، ومن يعدّل النصّ يترجم ما لا يُعرض.
 * وقد وقع فعلاً: ثلاثة مفاتيح (`quality_same` · `preview_hint_song` ·
 * `preview_hint_clip`) صارت يتيمة عند حذف الشيفرة الميتة التي كانت تقرؤها.
 *
 * **وما يقيسه**:
 *   ① **مجموعة المستهلكين** من المصدر المشحون لا من رأس أحد: نداء `t('مفتاح')`
 *      بمفتاح **حرفيّ** في `src/**\/*.ts` (خارج الجدول والاختبارات)، وقيم السمات
 *      `data-i18n` · `data-i18n-aria` · `data-i18n-title` في `index.html` — وهي
 *      المنافذ الثلاثة الوحيدة التي يقرأ بها `applyLang()`.
 *   ② **وموضع محسوب واحد مُعلَن** (`errText` تقرأ `` `code.${code}` ``) — يُقاس
 *      وجوده بالنصّ، ويُعلَن نطاقه. فلو زال الموضع من الشيفرة صارت مفاتيح
 *      `code.*` يتيمة **وسقط الحارس**، ولا يبقى الإعلان **غطاءً** بعد زوال سببه.
 *   ③ **والمجموعة الميتة المُعلَنة بالاسم**: تساويان في الاتجاهين — مفتاح ميت
 *      جديد ⇒ سقوط، ومدخل مُعلَن صار **مستهلكاً** ⇒ سقوط أيضاً (الإعلان يشيخ).
 *   ④ **وصفر محرف عربي في كل قيمة إنجليزية** (`i18n.en`) — وهو نصّ ما يراه قارئ
 *      الإنجليزية حرفياً، فمحرف عربي فيه تسرّبٌ إلى سطح إنجليزي.
 *
 * **وحدوده المعلَنة**: يقيس **الإشارة** لا الوصول الحيّ. مفتاح يقرؤه فرع لا
 * يُنفَّذ أبداً يبقى «مستهلكاً» هنا — وهذا بعينه حال المفاتيح الثلاثة قبل أن
 * تُحذف شيفرتها الميتة، ولهذا يبقى الحكم فيها مقيساً بالاسم لا بالوصول. والوصول
 * الحيّ للأسطح يقيسه `errorTextSurface.test.ts` (‏`errText`) و
 * `src/__tests__/errorTextSurface.test.ts` للمسارات الحقيقية.
 *
 * **والمُفسَدات** أسفل الملف تُقاس على **نفس الدالّة النقية** بمدخلات مُعدَّلة —
 * فالحارس يُثبت أنه يرى الخطأ بدل أن يُدَّعى.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import indexHtml from '../../index.html?raw';

/** جذر المستودع — بـ`fileURLToPath` لا `new URL(…, import.meta.url)`: قِيس في
 *  هذا المستودع أن الشكل الثاني يعطي في بيئة `jsdom` عنواناً مُقتطعاً عند أول
 *  فراغ في المسار (`HaramMute Desktop III`) فيصير `../../` من `C:\` (التفصيل
 *  في `cancelIsNotFailure.test.ts`). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const AR = /[\u0600-\u06FF\u0750-\u077F]/;

type Table = Record<string, string>;
const ar = i18n.ar as unknown as Table;
const en = i18n.en as unknown as Table;

/** **المواضع المحسوبة المُعلَنة** — واحد، ويُقاس وجوده في المصدر لا يُفترض. */
const COMPUTED_SITES = [
  {
    id: 'errText · code.<code>',
    file: 'src/i18n.ts',
    /** وجود الموضع نفسه: بناء المفتاح من الرمز. */
    present: /const key = `code\.\$\{code\}`/,
    /** نطاق ما يقرؤه: كل مفتاح بهذه البادئة. */
    covers: /^code\./,
    why:
      '`errText` هي الموضع **الوحيد** الذي يحوّل رمز الجسر إلى مفتاح، وهي تقرأ ' +
      'الجدول بمفتاح محسوب (`code.${code}`) لأن الرموز تأتي من الرست. ونطاقه ' +
      'مغلق: الرموز المُصدَرة تُقابل مدخلات `code.*` **في الاتجاهين** في ' +
      '`errorTextSurface.test.ts` و`scripts/check-bridge-codes.cjs`، فلا يقرأ ' +
      'المحسوب مفتاحاً لم يُفكَّر به.',
  },
];

/** **المفاتيح الميتة المُعلَنة بالاسم** — لا بعدد: مفتاح جديد يسقط الحارس،
 *  ومدخل هنا صار مستهلكاً يسقطه أيضاً. وكلها **مقيسة** لا مقدَّرة: لا نصّ حرفيّ
 *  لها في `src/**\/*.ts` المشحونة، ولا ربط `data-i18n*` في `index.html`، ولا
 *  يغطّيها الموضع المحسوب. وأكثرها **بقايا استبدال**: المفتاح القديم بقي والجديد
 *  حلّ مكانه (`drop_hint` ⇒ `drop_hint_plain` · `url_title` ⇒ `dl_url_title` ·
 *  `cuda_missing_text` ⇒ `cuda_missing_text` في `cuda.ts` لم يُربط). */
const KNOWN_DEAD: ReadonlyArray<{ key: string; why: string }> = [
  { key: 'actions_title', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'btn_info', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'btn_error', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'btn_panic', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'btn_clear', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'log_title', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'media_title', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'mode_title', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'fmt_label', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'btn_probe', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'kind_audio', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'kind_audio_desc', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'kind_video', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'kind_video_desc', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'url_title', why: 'بقايا استبدال: حلّ محلّه `dl_url_title` وهو المربوط في index.html:351' },
  { key: 'btn_download', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'drop_hint', why: 'بقايا استبدال: حلّ محلّه `drop_hint_plain` وهو المربوط في index.html:334' },
  { key: 'btn_browse', why: 'بقايا استبدال: حلّ محلّه `btn_browse_plain`' },
  { key: 'about_ok_modal', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  { key: 'preview_label', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة (ومعه شيفرة المعاينة الميتة)' },
  { key: 'cuda_missing_text', why: 'ميت قبل هذا العمل: `src/cuda.ts` يذكره في تعليق فقط ولا يناديه' },
  { key: 'open_folder_output', why: 'ميت قبل هذا العمل: لا نصّ حرفيّ ولا ربط سمة' },
  {
    key: 'log_demo_info',
    why: 'قارئه الوحيد اختبار وجودٍ (`idleSurface.test.ts:439` يعدّ المفاتيح) — لا سطح منتج',
  },
  {
    key: 'log_demo_warn',
    why: 'قارئه الوحيد اختبار وجودٍ (`idleSurface.test.ts:439` يعدّ المفاتيح) — لا سطح منتج',
  },
  {
    key: 'log_demo_error',
    why: 'قارئه الوحيد اختبار وجودٍ (`idleSurface.test.ts:439` يعدّ المفاتيح) — لا سطح منتج',
  },
  {
    key: 'log_demo_ready',
    why: 'قارئه الوحيد اختبار وجودٍ (`idleSurface.test.ts:439` يعدّ المفاتيح) — لا سطح منتج',
  },
];

/* ── المستهلكون: تُقرأ الملفات المشحونة من القرص، ويُقاس النصّ ─────────────── */

/** مصادر المستهلكين: `src/*.ts` المشحونة وحدها (`i18n.ts` جدول لا مستهلك،
 *  و`__tests__` ليست سطح منتج). */
function shippedSources(): Array<{ rel: string; text: string }> {
  const dir = join(REPO_ROOT, 'src');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'i18n.ts' && f !== 'vite-env.d.ts')
    .sort()
    .map((f) => ({ rel: `src/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
}

/** مفاتيح سمات الربط في `index.html` — العائلات الثلاث التي يقرأها `applyLang`. */
function htmlBoundKeys(html: string): Set<string> {
  const out = new Set<string>();
  for (const attr of ['data-i18n', 'data-i18n-aria', 'data-i18n-title']) {
    const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'g');
    for (const m of html.matchAll(re)) out.add(m[1]);
  }
  return out;
}

/** **القياس النقي**: مفاتيح الجدول ⇒ أيّها مستهلك وأيّها يتيم.
 *  يُمرَّر النصّ لا الملف، فتُقاس المُفسَدات على المدخلات نفسها. */
export function auditConsumers(
  keys: string[],
  sources: Array<{ rel: string; text: string }>,
  html: string,
  i18nSource: string,
  computed: typeof COMPUTED_SITES,
): { consumed: string[]; orphans: string[]; computedSites: string[]; computedMissing: string[] } {
  const bound = htmlBoundKeys(html);
  const computedSites: string[] = [];
  const computedMissing: string[] = [];
  const coveredBy: RegExp[] = [];
  for (const site of computed) {
    if (site.present.test(i18nSource)) {
      computedSites.push(site.id);
      coveredBy.push(site.covers);
    } else {
      computedMissing.push(site.id);
    }
  }

  const consumed: string[] = [];
  const orphans: string[] = [];
  for (const k of keys) {
    /* **نصّ حرفيّ مقتبس** لا `t('k')` وحده: قِيس أن مفاتيح حيّة تُقرأ بمفتاح
     * **مُختار من حرفيّات** لا بنداء مباشر —
     *   · `src/media.ts:50`  `outKind === 'video' ? 'out_video' : 'out_audio'`
     *   · `src/jobs.ts:208`  عضو في اتحاد أنواع (`| 'stop_requested'`)
     *   · `src/jobs.ts:227`  `{ key: 'stop_requested', … }`
     *   · `src/main.ts:94`   `sepLabel.dataset.i18n = key` (قيمة من خريطة حرفية)
     * فقاعدة `t('k')` وحدها أعطت **نتائج كاذبة**: أعلنت `stop_requested` ميتاً
     * و`stopBar.test.ts:221` يقيس نصّه المعروض حيّاً. والاقتباس يمنع أيضاً
     * المطابقة الجزئية (`queue_empty_running` داخل `queue_empty_running_hint`). */
    const literalInSrc = sources.some((s) => s.text.includes(`'${k}'`) || s.text.includes(`"${k}"`));
    const byComputed = coveredBy.some((re) => re.test(k));
    if (literalInSrc || bound.has(k) || byComputed) consumed.push(k);
    else orphans.push(k);
  }
  return { consumed, orphans, computedSites, computedMissing };
}

const SRC = shippedSources();
const I18N_SRC = readFileSync(join(REPO_ROOT, 'src/i18n.ts'), 'utf8');
const KEYS = Object.keys(ar);
const RESULT = auditConsumers(KEYS, SRC, indexHtml as string, I18N_SRC, COMPUTED_SITES);
const DEAD_KEYS = new Set(KNOWN_DEAD.map((d) => d.key));
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

describe('ط-٤ · لا مفتاح ترجمة بلا مستهلك', () => {
  it('القياس ليس باطلاً: الجدول والمصادر والصفحة مقروءة فعلاً', () => {
    expect(KEYS.length, 'مفاتيح الجدول العربي').toBeGreaterThan(100);
    expect(SRC.length, 'وحدات `src/*.ts` المقروءة').toBeGreaterThan(10);
    expect(htmlBoundKeys(indexHtml as string).size, 'مفاتيح سمات الربط في index.html').toBeGreaterThan(50);
    expect(RESULT.consumed.length, 'مفاتيح لها مستهلك — لو كان صفراً لمرّ الفحص بلا معنى').toBeGreaterThan(100);
    expect(
      RESULT.computedMissing,
      'الموضع المحسوب المُعلَن موجود في المصدر (وإلا فالإعلان غطاء بعد زوال سببه)',
    ).toEqual([]);
  });

  it('وكل مفتاح بلا مستهلك **مُعلَن بالاسم** — ولا يتيم غير مُعلَن', () => {
    const undeclared = RESULT.orphans.filter((k) => !DEAD_KEYS.has(k));
    expect(
      undeclared,
      'مفاتيح بلا مستهلك وليست في القائمة المُعلَنة — أضِف قارئاً أو أعلِنها بسببها',
    ).toEqual([]);
  });

  it('ولا مدخل مُعلَن مات سببُه: مفتاح مُعلَن صار له مستهلك ⇒ الإعلان يشيخ', () => {
    const revived = [...DEAD_KEYS].filter((k) => RESULT.consumed.includes(k));
    expect(revived, 'مفاتيح مُعلَنة ميتة ولها الآن قارئ — احذفها من الإعلان').toEqual([]);
  });

  it('والقائمة المُعلَنة لا تحمل مفتاحاً غير موجود في الجدول', () => {
    const ghosts = [...DEAD_KEYS].filter((k) => !(k in ar));
    expect(ghosts, 'مدخل إعلان لمفتاح محذوف من الجدول').toEqual([]);
  });

  it('والتقرير: كم مفتاحاً مستهلك وكم يتيماً (يُطبع للتقرير)', () => {
    // eslint-disable-next-line no-console
    console.log(
      `  i18n: ${KEYS.length} مفتاحاً · مستهلك ${RESULT.consumed.length} · ` +
        `يتيم مُعلَن ${KNOWN_DEAD.length} · مواضع محسوبة ${RESULT.computedSites.length}`,
    );
    expect(sameSet(RESULT.orphans, [...DEAD_KEYS])).toBe(true);
  });
});

describe('ط-٤ · لا محرف عربي في النصّ الإنجليزي (سطح قارئ الإنجليزية)', () => {
  it('`i18n.en`: كل قيمة بلا محرف عربي', () => {
    const offenders = Object.keys(en).filter((k) => AR.test(en[k])).map((k) => `${k}: «${en[k].slice(0, 40)}»`);
    expect(offenders, 'قيم إنجليزية تحمل عربية ⇒ عربيةٌ على سطح قارئ الإنجليزية').toEqual([]);
  });

  it('والقياس ليس باطلاً: قيم إنجليزية كثيرة مقروءة', () => {
    expect(Object.keys(en).length).toBeGreaterThan(100);
    expect(Object.values(en).filter((v) => v.trim() !== '').length).toBe(Object.keys(en).length);
  });
});

/* ══ المُفسَدات: على الدالّة النقية نفسها — لا على نسخة منها ═════════════════ */
describe('ط-٤ · حارس المستهلك يرى الخطأ (مُفسَدات)', () => {
  const strip = (text: string, needle: string): string => {
    if (!text.includes(needle)) throw new Error(`مُفسَد لم يطابق: ${needle}`);
    return text.split(needle).join('');
  };

  it('مُفسَد (أ): مفتاح جديد بلا مستهلك ⇒ يتيم غير مُعلَن', () => {
    const r = auditConsumers([...KEYS, 'brand_new_orphan'], SRC, indexHtml as string, I18N_SRC, COMPUTED_SITES);
    const undeclared = r.orphans.filter((k) => !DEAD_KEYS.has(k));
    expect(undeclared).toEqual(['brand_new_orphan']);
  });

  it('مُفسَد (ب): حذف قارئ مفتاح حيّ ⇒ يصير يتيماً غير مُعلَن', () => {
    const target = 'sep_out_audio';
    expect(KEYS.includes(target), 'المفتاح المقصود موجود').toBe(true);
    expect(RESULT.consumed.includes(target), 'وهو مستهلك قبل المُفسَد').toBe(true);
    const from = SRC.find((s) => s.text.includes(`'${target}'`));
    expect(from, `قارئ ${target} موجود`).toBeTruthy();
    const mutated = SRC.map((s) =>
      s === from ? { ...s, text: s.text.split(`'${target}'`).join("'__removed__'") } : s,
    );
    const r = auditConsumers(KEYS, mutated, indexHtml as string, I18N_SRC, COMPUTED_SITES);
    expect(r.orphans.filter((k) => !DEAD_KEYS.has(k))).toEqual([target]);
  });

  it('مُفسَد (ج): حذف ربط `data-i18n` من الصفحة ⇒ المفتاح يصير يتيماً', () => {
    // الضحيّة: مفتاح **مربوط في الصفحة وحدها** (لا نصّ حرفيّ له في `src`) — وإلا
    // بقي مستهلكاً من الشيفرة فلم يُثبت المُفسَد شيئاً.
    const victim = [...htmlBoundKeys(indexHtml as string)].find(
      (k) => !SRC.some((s) => s.text.includes(`'${k}'`) || s.text.includes(`"${k}"`)),
    );
    expect(victim, 'مفتاح مربوط في الصفحة وحدها').toBeTruthy();
    expect(RESULT.consumed.includes(victim!), 'وهو مستهلك قبل المُفسَد').toBe(true);
    const mutatedHtml = (indexHtml as string).replace(new RegExp(`\\sdata-i18n="${victim}"`, 'g'), '');
    expect(mutatedHtml, 'الاستبدال وقع فعلاً').not.toBe(indexHtml as string);
    const r = auditConsumers([victim!], SRC, mutatedHtml, I18N_SRC, COMPUTED_SITES);
    expect(r.orphans).toEqual([victim]);
  });

  it('مُفسَد (د): زوال الموضع المحسوب (`errText`) ⇒ `code.*` تصير يتيمة والحارس يسقط', () => {
    const mutatedI18n = strip(I18N_SRC, 'const key = `code.${code}`');
    const r = auditConsumers(KEYS, SRC, indexHtml as string, mutatedI18n, COMPUTED_SITES);
    expect(r.computedMissing, 'الإعلان صار غطاءً بلا موضع').toEqual(['errText · code.<code>']);
    const codeOrphans = r.orphans.filter((k) => k.startsWith('code.'));
    expect(codeOrphans.length, 'مفاتيح `code.*` صارت يتيمة').toBeGreaterThan(0);
  });

  it('مُفسَد (هـ): إعلانٌ لمفتاح صار مستهلكاً ⇒ الإعلان يشيخ فيُسقط', () => {
    const revived = 'actions_title';
    expect(KEYS.includes(revived)).toBe(true);
    const sources = SRC.map((s, i) => (i === 0 ? { ...s, text: `${s.text}\nconst probe = t('${revived}');\n` } : s));
    const r = auditConsumers(KEYS, sources, indexHtml as string, I18N_SRC, COMPUTED_SITES);
    expect(r.consumed.includes(revived), 'صار مستهلكاً بالمدخل المُعدَّل').toBe(true);
    expect([...DEAD_KEYS].filter((k) => r.consumed.includes(k))).toContain(revived);
  });

  it('مُفسَد (و): محرف عربي في قيمة إنجليزية ⇒ يسقط', () => {
    const mutated: Table = { ...en, set_notify: 'تم' };
    const offenders = Object.keys(mutated).filter((k) => AR.test(mutated[k]));
    expect(offenders).toEqual(['set_notify']);
  });

  it('مُفسَد (ط): قاعدة النداء المباشر وحدها تُنذر كذباً على مفتاح يُقرأ بحرفيّ مُختار', () => {
    // الضحيّة الحقيقية المقيسة: `stop_requested` يُقرأ من خريطة حرفيّات
    // (`jobs.ts:227`) و`stopBar.test.ts:221` يقيس نصّه المعروض حيّاً. فالقاعدة
    // الضيّقة كانت **تُعلنه ميتاً** — وهذا مُفسَد على **القاعدة** لا على الجدول:
    // لو ضُيّقت القاعدة عادت النتيجة الكاذبة، فيسقط هذا الفحص.
    const target = 'stop_requested';
    const narrow = KEYS.filter((k) => {
      const lit = SRC.some((s) => s.text.includes(`t('${k}'`) || s.text.includes(`t("${k}"`));
      return !lit && !htmlBoundKeys(indexHtml as string).has(k);
    });
    expect(narrow, 'القاعدة الضيّقة تُنذر `stop_requested` كذباً').toContain(target);
    expect(RESULT.consumed, 'والقاعدة المقيسة تعدّه مستهلكاً').toContain(target);
  });
});
