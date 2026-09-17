#!/usr/bin/env node
/**
 * بوابة المصفوفة — تحقّق من وجود سجلّ في صفوف الاختبار اليدوي الإلزامية.
 *
 * البند: 0.2.7 ج-١١. القاعدة: «البوابة التي ليست في CI ليست بوابة».
 * الصفوف تُنفَّذ يداً بيد المالك على عتاد حقيقي، فهذه البوابة لا تُنفّذ اختباراً —
 * بل تمنع المرور ما دام صفّ إلزامي بلا **سجل**.
 *
 * تعريف «مملوء» المعتمد (خطة 0.2.7): العمود الأخير من الصفّ يحمل
 *   تاريخاً (YYYY-MM-DD) + جهازاً (رمز/اسم) + نتيجة (نصّ غير فارغ).
 * ونقص أيٍّ من الثلاثة ⇒ الصفّ فارغ.
 *
 * رموز الخروج:
 *   0 = كل الصفوف الإلزامية مملوءة · 1 = بقي صفّ ناقص · 2 = خطأ بنية/استعمال
 *   (‏2 عمداً: «صفر صفّ إلزامي» و«الملف مفقود» ليسا نجاحاً — حارس لا يرى ليس حارساً.)
 *
 * بلا اعتماديات npm: `node:fs` و`node:path` وحدهما.
 * الاستعمال: node scripts/matrix-check.cjs [--file=<path>] [--quiet]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join('qa', 'TEST-MATRIX.md');
const MANDATORY_RE = /\[إلزامي\]/;

const EXIT = { PASS: 0, INCOMPLETE: 1, MISUSE: 2 };

// ---------------------------------------------------------------------------
// تحليل صفوف Markdown
// ---------------------------------------------------------------------------

/**
 * يقسم سطر جدول إلى خاناته. يحترم `\|` (شرطة مائلة عكسية تسبق الأنبوب) كأنبوب
 * حرفي داخل الخانة — فالملف يوثّق قالب الصفّ بهذه الصيغة.
 *
 * الطرفان يُطرحان **بالقياس لا بالموضع**: ما قبل أول `|` فارغٌ دائماً فيُطرح،
 * وأما الخانة الأخيرة فتُطرح **فقط إن كان الصفّ منتهياً بأنبوب**. و`slice(1,-1)`
 * كان يطرحها دائماً، فصفٌّ صحيح في Markdown بلا أنبوب ختامي
 * (`| 9.9 **[إلزامي]** | ... | ✅ · 2026-09-17 · جهاز |`) يفقد خانته الأخيرة
 * ⇒ يُقيَّم عمودٌ آخر (عطل مُعاد إنتاجه: طُبع «فارغ بلا تاريخ · بلا نتيجة»).
 * @param {string} line
 * @returns {string[]|null} الخانات مقصوصة، أو null إن لم يكن سطر جدول.
 */
function splitRow(line) {
  if (!/^\s*\|/.test(line)) return null;
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // اطرح الطرفين الفارغين (قبل أول `|` وبعد آخر `|`).
  if (cells.length < 2) return null;
  const body = cells.slice(1);
  // `cur` هو ما تلا آخر أنبوب: فارغاً (أو مسافات) ⇒ الصفّ منتهٍ بأنبوب.
  const endedWithPipe = cur.trim() === '';
  return (endedWithPipe ? body.slice(0, -1) : body).map((c) => c.trim());
}

/** هل الخانة فاصل ترويسة (`---`, `:--:`, …)؟ */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^[-:\s]+$/.test(c) && c !== '');
}

/**
 * يستخرج صفوف البيانات من نصّ المصفوفة.
 *
 * الجدول يُعرَّف بالبنية لا بعنوان الخانة: العنوان يختلف فعلاً بين أقسام الملف
 * («النتيجة المتوقَّعة (بسندها من الكود)» مقابل «النتيجة المتوقَّعة»)، فالاعتماد
 * على نصّه كان سيُسقط أقساماً كاملة بصمت.
 *
 * كل جدول: سطر ترويسة (يُسقَط) ← سطر فاصل ← صفوف البيانات.
 *
 * الخانات تُقرأ **بالموضع** من الطرفين: الأولى هي `#` والأخيرة هي النتيجة. عدُّ
 * الخانات لا يصلح حَكماً — صفّ نتيجته فارغة يُكتب `| |` فيُقرأ ستّ خانات، وصفّ
 * نتيجة مُملوءة يُقرأ خمساً؛ فالحكم بالموضع يستوعب الحالتين.
 *
 * @param {string} text
 * @returns {Array<{line:number,mandatory:boolean,id:string,resultCell:string}>}
 */
function parseRows(text) {
  const lines = text.split(/\r?\n/);

  // المرحلة ١: مواقع أسطر الجداول، وأيُّ سطر يسبق فاصلاً مباشرةً (فهو ترويسة).
  const tableRows = []; // { index, raw }
  const headerIndexes = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const raw = splitRow(lines[i]);
    if (!raw) continue;
    if (isSeparatorRow(raw)) {
      // السطر السابق للفاصل هو ترويسة الجدول — يُسقَط بمقارنة الموضع،
      // ولا يُحذف بالعدّ من المصفوفة (وهو ما أكل آخر صفٍّ في كل جدول).
      for (let k = tableRows.length - 1; k >= 0; k -= 1) {
        if (tableRows[k].index === i - 1) {
          headerIndexes.add(tableRows[k].index);
          break;
        }
      }
      continue;
    }
    tableRows.push({ index: i, raw });
  }

  // المرحلة ٢: صفوف المصفوفة = ما بقي بعد إسقاط الترويسات، ويبدأ بمعرّف رقمي.
  const rows = [];
  for (const { index, raw } of tableRows) {
    if (headerIndexes.has(index)) continue;
    if (raw.length < 3) continue; // ليس صفّ مصفوفة (جدول من عمودين)
    if (!/^\d+(?:\.\d+)*/.test(raw[0])) continue;

    rows.push({
      line: index + 1,
      // الوسم يُفحَص على الخانة الخام قبل إسقاط `**` — الصفوف تكتب `**[إلزامي]**`.
      mandatory: MANDATORY_RE.test(raw[0]),
      id: (raw[0].match(/^\d+(?:\.\d+)*/) || [''])[0],
      resultCell: raw[raw.length - 1],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// الحكم على «مملوء»
// ---------------------------------------------------------------------------

/** يوحّد الأرقام العربية-الهندية والفارسية إلى لاتينية. */
function normalizeDigits(s) {
  return s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/**
 * يبحث عن تاريخ في الخانة. يستقبل `YYYY-MM-DD` وأخواتها (`YYYY/MM/DD`، `YYYY.MM.DD`)
 * والأرقام العربية-الهندية، وكذلك `YYYY-MM` (سنة وشهر — أدقّ من لا شيء ومقبول).
 * @param {string} cell
 * @returns {string|null} التاريخ كما وُجد، أو null.
 */
function findDate(cell) {
  const norm = normalizeDigits(cell);
  const full = norm.match(/(?:^|[^\d])(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?![\d])/);
  if (full) return full[1];
  const ym = norm.match(/(?:^|[^\d])(\d{4}[-/.]\d{1,2})(?![\d])/);
  if (ym) return ym[1];
  return null;
}

/** يسقط التاريخ من الخانة (ليُفحَص الباقي: نتيجة وجهاز). */
function stripDates(cell) {
  return normalizeDigits(cell).replace(/\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?/g, ' ');
}

/** علامات النتيجة المسموحة (فهرس «كيف تُملأ المصفوفة»). */
const RESULT_RE = /^(✅|❌|⚠️?|—|-{1,2})$/;
/** علامة «لم يُنفَّذ» — حالةٌ مسجَّلة، لا خانة فارغة. تُقبل نصّاً حرّاً. */
const NOT_RUN_RE = /^(—|-{1,2}|لم\s*(?:يُ|ي)?نفَّذ|لم\s*ينفذ)$/;

/** يفصل الخانة إلى خانات فرعية على الفواصل `·` أو `|`. */
function splitSlots(cell) {
  return normalizeDigits(cell)
    .split(/[·|]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** هل النصّ يصلح رمزاً/اسماً لجهاز؟ (ليس علامة نتيجة، وليس مجرّد رقم) */
function isDeviceToken(s) {
  if (!s) return false;
  if (RESULT_RE.test(s)) return false;
  if (!/\p{L}/u.test(s)) return false; // لا حروف ⇒ ليس اسماً (يرفض «12.3s» و«3060»)
  if (/^\d+(\.\d+)*$/.test(s)) return false;
  return true;
}

/**
 * يحكم على خانة النتيجة: هل فيها **تاريخ + جهاز + نتيجة**؟
 *
 * الثلاثة شرط متّصل: نقص أيٍّ منها ⇒ الصفّ فارغ (تعريف خطة 0.2.7).
 * @param {string} cell
 * @returns {{ok:boolean,date:string|null,device:string|null,result:string|null,missing:string[]}}
 */
function assessCell(cell) {
  const raw = (cell || '').trim();
  if (raw === '') {
    return { ok: false, date: null, device: null, result: null, missing: ['تاريخ', 'جهاز', 'نتيجة'] };
  }

  const date = findDate(raw);
  const slots = splitSlots(stripDates(raw));

  // مرشَّحو الجهاز: كل خانة ليست علامة نتيجة. الجهاز أول خانة تحمل حروفاً.
  const deviceSlots = slots.filter((s) => !RESULT_RE.test(s));
  const namedDevice = deviceSlots.find(isDeviceToken);
  const device = deviceSlots.length > 0 ? (namedDevice !== undefined ? namedDevice : deviceSlots[0]) : null;

  // النتيجة: علامة صريحة، أو نصّ حرّ (آخر خانة تحمل حروفاً وليست الجهاز).
  let result = slots.find((s) => RESULT_RE.test(s)) || null;
  const notRun = NOT_RUN_RE.test(raw);
  if (result === null && !notRun) {
    const free = deviceSlots.filter((s) => s !== device && /\p{L}/u.test(s));
    if (free.length > 0) result = free[free.length - 1];
  }

  const missing = [];
  if (date === null) missing.push('تاريخ');
  if (device === null) missing.push('جهاز');
  if (result === null) missing.push('نتيجة');

  return { ok: missing.length === 0, date, device, result, missing };
}

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { file: DEFAULT_FILE, quiet: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else if (!arg.startsWith('-')) opts.file = arg;
    else {
      process.stderr.write(`وسيط غير معروف: ${arg}\n`);
      opts.help = true;
    }
  }
  return opts;
}

const USAGE = `الاستعمال: node scripts/matrix-check.cjs [--file=<path>] [--quiet]

  --file=<path>  مسار المصفوفة (افتراضاً qa/TEST-MATRIX.md)
  --quiet        لا تطبع إلا الملخّص وسطور النقص
  --selfcheck    يفحص الحارس نفسه على مصفوفات مصنوعة (مُفسَد · ضابط · صفر مدخل)
  --help         هذه الرسالة

يرجع 0 إن اكتملت كل الصفوف الإلزامية · 1 إن بقي صفّ ناقص · 2 عند خطأ بنية/استعمال.`;

/* ---------------------------------------------------------------------------
// الفحص الذاتي: الحارس يُسقط على نصّ مُخرَّب، ويمرّ على نصّ سليم رآه فعلاً
// ---------------------------------------------------------------------------
// العطل الذي وُلد هذا الفحص لأجله: `slice(1,-1)` كان يطرح الخانة الأخيرة من
// صفٍّ **بلا أنبوب ختامي** — وهو صفّ صحيح في Markdown — فيقرأ عموداً آخر
// ويطبع «فارغ بلا تاريخ · بلا نتيجة» عن صفٍّ مملوء. فالفحص يشغّل هذا الملف
// نفسه (لا دواله وحده) على مصفوفات مصنوعة، ويحكم على رمز الخروج وعلى النصّ:
//
//   ① **ضابط بلا أنبوب**: صفّ مملوء بلا أنبوب ختامي ⇒ يجب أن يمرّ (0)
//      **وقد رأى تاريخه وجهازه ونتيجته** — وإلا مرّ لأنه لم ينظر.
//   ② **تكافؤ**: الصفّ نفسه بأنبوب ختامي ⇒ نفس الحكم ونفس السبب المطبوع.
//   ③ **مُفسَد**: صفّ إلزامي بخانة نتيجة فارغة ⇒ يجب أن يُسقط الحارس (1).
//   ④ **صفر مدخل**: مصفوفة بلا صفّ إلزامي ⇒ يجب أن تفشل بصوت عالٍ (2).
//
// كل عمليات الخادم/الطفل تُطلق بلا نافذة (`windowsHide`)، والمجلد المصنوع
// تحت `os.tmpdir()` ويُحذف في النهاية. */

const FIXTURE_HEADER = [
  '| # | البيئة | الخطوات | النتيجة المتوقَّعة | النتيجة |',
  '| --- | --- | --- | --- | --- |',
].join('\n');

/** صفّ مصفوفة مصنوع. `tail` = خانة النتيجة، و`close` = الأنبوب الختامي. */
function fixtureRow(result, close) {
  const head = '| 9.9 **[إلزامي]** | بيئة مصنوعة | خطوات مصنوعة | نتيجة متوقَّعة |';
  return close ? `${head} ${result} |` : `${head} ${result}`;
}

function selfcheck() {
  const fsMod = require('node:fs');
  const osMod = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'hl-matrix-selfcheck-'));
  const failures = [];
  const FILLED = '✅ · 2026-09-17 · Win11-26200/i9-10850K/RTX3070 · نصّ النتيجة';
  const cases = [
    {
      label: '① ضابط: صفّ مملوء بلا أنبوب ختامي يُقيَّم مملوءاً',
      rows: [fixtureRow(FILLED, false)],
      expectStatus: EXIT.PASS,
      expectText: ['1 من 1 مملوء', '2026-09-17', 'Win11-26200/i9-10850K/RTX3070'],
      forbidText: ['بلا تاريخ'],
    },
    {
      label: '② تكافؤ: الصفّ نفسه بأنبوب ختامي يعطي نفس الحكم',
      rows: [fixtureRow(FILLED, true)],
      expectStatus: EXIT.PASS,
      expectText: ['1 من 1 مملوء', '2026-09-17', 'Win11-26200/i9-10850K/RTX3070'],
      forbidText: ['بلا تاريخ'],
    },
    {
      label: '③ مُفسَد: خانة نتيجة فارغة تُسقط الحارس (1)',
      rows: [fixtureRow('', true)],
      expectStatus: EXIT.INCOMPLETE,
      expectText: ['9.9', 'بلا'],
      forbidText: [],
    },
    {
      label: '④ صفر مدخل: بلا صفّ إلزامي ⇒ فشل بصوت عالٍ (2)',
      rows: ['| 9.9 | بيئة مصنوعة | خطوات | نتيجة متوقَّعة | ✅ · 2026-09-17 · جهاز · نصّ |'],
      expectStatus: EXIT.MISUSE,
      expectText: ['صفر صفّ إلزامي'],
      forbidText: [],
    },
  ];

  for (const c of cases) {
    const file = path.join(dir, `case-${cases.indexOf(c)}.md`);
    fsMod.writeFileSync(file, `${FIXTURE_HEADER}\n${c.rows.join('\n')}\n`, 'utf8');
    const r = spawnSync(process.execPath, [__filename, `--file=${file}`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const problems = [];
    if (r.status !== c.expectStatus) {
      problems.push(`رمز الخروج ${r.status} بدل ${c.expectStatus}`);
    }
    for (const t of c.expectText) {
      if (!out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    for (const t of c.forbidText) {
      if (out.includes(t)) problems.push(`المخرَج يحوي «${t}» وهو ممنوع`);
    }
    if (problems.length === 0) {
      process.stdout.write(`✅ ${c.label}\n`);
    } else {
      failures.push(`${c.label} — ${problems.join(' · ')}\n${out.trim()}`);
      process.stdout.write(`✗ ${c.label} — ${problems.join(' · ')}\n`);
    }
  }

  try {
    fsMod.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* مجلد مؤقت: فشل حذفه لا يُسقط الفحص */
  }

  if (failures.length > 0) {
    process.stderr.write(`\n✗ الفحص الذاتي: ${failures.length} حالة فشلت\n`);
    return EXIT.MISUSE;
  }
  process.stdout.write(`\n✓ الفحص الذاتي: ${cases.length} من ${cases.length} حالة سليمة\n`);
  return EXIT.PASS;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.MISUSE;
  }

  const file = path.resolve(opts.file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`خطأ: تعذّرت قراءة المصفوفة «${file}» — ${err.message}\n`);
    return EXIT.MISUSE;
  }

  const rows = parseRows(text);
  const mandatory = rows.filter((r) => r.mandatory);

  // حارس لا يرى ليس حارساً: صفر صفّ إلزامي = بنية الملف تغيّرت ⇒ فشل بصوت عالٍ.
  if (mandatory.length === 0) {
    process.stderr.write(
      'خطأ بنية: صفر صفّ إلزامي.\n' +
        `الملف: ${file}\n` +
        `صفوف الجدول المكتشفة: ${rows.length}\n` +
        'توقّف الحارس: «صفر صفّ إلزامي» ليس نجاحاً — تحقّق أن الوسم [إلزامي] ما زال في الخانة الأولى،\n' +
        'وأن الجدول ما زال خمس خانات، وأن الملف هو المصفوفة المقصودة.\n'
    );
    return EXIT.MISUSE;
  }

  const assessed = mandatory.map((r) => ({ ...r, verdict: assessCell(r.resultCell) }));
  const filled = assessed.filter((r) => r.verdict.ok);
  const incomplete = assessed.filter((r) => !r.verdict.ok);

  const out = [];
  if (!opts.quiet) {
    out.push(`المصفوفة: ${file}`);
    out.push(`صفوف الجدول: ${rows.length} · الإلزامية: ${mandatory.length}`);
    out.push('');
    for (const r of assessed) {
      const status = r.verdict.ok ? 'مملوء' : 'فارغ';
      const reason = r.verdict.ok
        ? `${r.verdict.result} · ${r.verdict.date} · ${r.verdict.device}`
        : `بلا ${r.verdict.missing.join(' · بلا ')}`;
      out.push(`  ${r.id.padEnd(6)} ${status.padEnd(6)} ${reason}`);
    }
    out.push('');
  } else if (incomplete.length > 0) {
    for (const r of incomplete) {
      out.push(`  ${r.id.padEnd(6)} فارغ   بلا ${r.verdict.missing.join(' · بلا ')}`);
    }
    out.push('');
  }

  out.push(`الملخّص: ${filled.length} من ${mandatory.length} مملوء`);
  if (incomplete.length > 0) {
    out.push(`الناقص: ${incomplete.map((r) => r.id).join(' · ')}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);

  return incomplete.length > 0 ? EXIT.INCOMPLETE : EXIT.PASS;
}

if (require.main === module) {
  // `--selfcheck` قبل parseArgs: هو ليس مساراً ولا وسيطاً للمصفوفة.
  process.exitCode = process.argv.includes('--selfcheck')
    ? selfcheck()
    : main(process.argv);
}

module.exports = { parseRows, assessCell, findDate, splitRow, main, selfcheck };
