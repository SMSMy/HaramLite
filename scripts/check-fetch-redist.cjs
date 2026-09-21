#!/usr/bin/env node
/* حارس `fetch_redist.js` — البند ن-٢ في خطة 0.2.9 §١١.
 *
 * **العطل الذي وُلد هذا الحارس لأجله** (مقيس في `scripts/fetch_redist.js` قبل
 * الإصلاح، السطر 87 من النسخة القديمة):
 *
 *     if (fs.existsSync(dest)) { console.log(`${comp.dest} already exists, skipping
 *     download.`); return; }
 *
 * أي أن البصمة كانت تُفحَص **عند التنزيل فقط**: ملف موجود ببصمة خاطئة (تنزيل قديم،
 * أو بايتات أُبدلت يدوياً، أو نسخ جزئي) **يُشحن بلا قراءة بصمة واحدة** — و`repair.rs`
 * في التطبيق يرفض تلك البايتات نفسها، فينكسر الإصلاح الذاتي عند المستخدم ولا يسقط
 * شيء في البناء. وهذا بعينه ما تشترطه خطة 0.2.9 §١١: «التحقّق عند الوجود».
 *
 * **وما يقيسه هذا الحارس ثلاثة أجزاء**:
 *
 *   ① **تكافؤ الجدولين** (فحص ساكن): `COMPONENTS` في `scripts/fetch_redist.js`
 *      مقابل `COMPONENTS` في `src-tauri/src/repair.rs` — الاسم البعيد · الاسم
 *      المحلي · المجلد · بصمة SHA-256 · والعدد. تعليق الملف يقول «MUST stay
 *      byte-identical» ولا شيء كان يفرضه؛ وأي افتراق يعني أن الجالب يشحن بايتات
 *      غير التي يتحقّق منها التطبيق. جدول فارغ أو غير مقروء ⇒ **فشل بنيوي (2)**.
 *   ② **السلوك على بيئة مصنوعة** (بلا شبكة إطلاقاً: `--asset-url-base` إلى منفذ
 *      لا يخدمه أحد): موجود وبصمته صحيحة ⇒ يمرّ **بلا تنزيل** · موجود وبصمته
 *      خاطئة ⇒ **يسقط** ويسمّي البصمتين والملف **ولا يمسّه** · `--verify` كذلك ·
 *      و`vc_redist.x64.exe` تحت أرضية الحجم ⇒ يسقط.
 *   ③ **صفر مدخل**: مجلد بلا موارد + `--verify` ⇒ فشل مسمّى، لا نجاح فارغ.
 *
 * **والحارس يُقاس بنفسه**: نسخة من السكربت أُعيد فيها سلوك ما قبل الإصلاح (وجود ⇒
 * تخطٍّ بلا بصمة) **تمرّ** على البيئة المخالفة التي يسقط عليها السكربت المشحون —
 * فالإصلاح هو ما يمسك العطل، لا شيء آخر. ونسختان مصنوعتان لجدول الجالب (بصمة
 * منزاحة · مكوّن زائد) تُسقطان فحص التكافؤ.
 *
 * **ما لم يُقَس هنا**: مسار التنزيل نفسه (يحتاج شبكة وشهادة TLS ⇒ لا يُقاس في
 * بيئة مصنوعة). وموضع العطل كان مسار **الوجود**، وهو المقيس.
 *
 * بلا اعتماديات npm: `node:fs` · `node:path` · `node:crypto` · `node:child_process`.
 * الاستعمال: node scripts/check-fetch-redist.cjs [--repo=<dir>]
 * رموز الخروج: 0 = سليم · 1 = فشل · 2 = بنية/استعمال.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXIT = { PASS: 0, FAIL: 1, MISUSE: 2 };
const ROOT = path.resolve(__dirname, '..');
const SCRIPT_REL = path.join('scripts', 'fetch_redist.js');
const REPAIR_RS_REL = path.join('src-tauri', 'src', 'repair.rs');
const SHA_RE = /^[0-9a-f]{64}$/;
/** منفذ لا يخدمه أحد: أي محاولة تنزيل تفشل فوراً بدل أن تنزّل مئات الميغابايت. */
const DEAD_BASE = 'http://127.0.0.1:1/assets-v1';

class GuardError extends Error {
  constructor(message, code = EXIT.MISUSE) {
    super(message);
    this.code = code;
  }
}

function sha256OfBuf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// ① قراءة الجدولين (من المصدرين، لا من نسخة ثالثة في هذا الملف)
// ---------------------------------------------------------------------------

/** `COMPONENTS` من `scripts/fetch_redist.js`: حقل `dest` اسمه المحلي. */
function componentsFromScript(src) {
  const at = src.indexOf('const COMPONENTS = [');
  if (at < 0) return null;
  const end = src.indexOf('];', at);
  if (end < 0) return null;
  const block = src.slice(at, end);
  const out = [];
  for (const m of block.matchAll(/\{([^}]*)\}/g)) {
    const body = m[1];
    const f = (n) => {
      const r = new RegExp(`\\b${n}\\s*:\\s*'([^']*)'`).exec(body);
      return r ? r[1] : null;
    };
    out.push({ asset: f('asset'), local: f('dest'), subdir: f('subdir'), sha256: f('sha256') });
  }
  return out;
}

/** `COMPONENTS` من `src-tauri/src/repair.rs` (نفس مرساة ثقة التطبيق). */
function componentsFromRust(src) {
  const at = src.indexOf('pub const COMPONENTS');
  if (at < 0) return null;
  const end = src.indexOf('];', at);
  if (end < 0) return null;
  const block = src.slice(at, end);
  const out = [];
  for (const m of block.matchAll(/Component\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const f = (n) => {
      const r = new RegExp(`\\b${n}\\s*:\\s*"([^"]*)"`).exec(body);
      return r ? r[1] : null;
    };
    out.push({ asset: f('asset'), local: f('local'), subdir: f('subdir'), sha256: f('sha256') });
  }
  return out;
}

/** يحرس بنية الجدولين: لا فراغ، ولا حقل ناقص، ولا بصمة غير سداسية عشرية. */
function validateTable(rows, label) {
  if (!Array.isArray(rows)) throw new GuardError(`لم أقرأ COMPONENTS من ${label}`);
  if (rows.length === 0) {
    throw new GuardError(`COMPONENTS في ${label} صفر مكوّن — لا شيء أقابله، وهذا فشل بنيوي لا نجاح.`);
  }
  for (const [i, r] of rows.entries()) {
    for (const k of ['asset', 'local', 'subdir', 'sha256']) {
      if (!r[k]) throw new GuardError(`COMPONENTS في ${label}: المكوّن ${i + 1} بلا حقل «${k}»`);
    }
    if (!SHA_RE.test(r.sha256)) {
      throw new GuardError(`COMPONENTS في ${label}: بصمة ${r.asset} ليست SHA-256 سداسية عشرية (${r.sha256})`);
    }
  }
  return rows;
}

/**
 * يقابل الجدولين مكوّناً بمكوّن (بالاسم البعيد) ويرد قائمة الفروق مسمّاة.
 * @returns {string[]} الفروق — فارغة تعني تكافؤاً.
 */
function compareTables(scriptRows, rustRows) {
  const diffs = [];
  const key = (r) => `${r.asset}`;
  const a = new Map(scriptRows.map((r) => [key(r), r]));
  const b = new Map(rustRows.map((r) => [key(r), r]));
  for (const [k, r] of b) {
    if (!a.has(k)) diffs.push(`ناقص في الجالب: ${k} (في repair.rs: ${r.local} ← ${r.subdir}/)`);
  }
  for (const [k, r] of a) {
    if (!b.has(k)) diffs.push(`زائد في الجالب: ${k} (${r.local} ← ${r.subdir}/) — ليس في repair.rs`);
  }
  for (const [k, r] of a) {
    const s = b.get(k);
    if (!s) continue;
    if (r.local !== s.local) diffs.push(`${k}: الاسم المحلي «${r.local}» في الجالب و«${s.local}» في repair.rs`);
    if (r.subdir !== s.subdir) diffs.push(`${k}: المجلد «${r.subdir}» في الجالب و«${s.subdir}» في repair.rs`);
    if (r.sha256 !== s.sha256) {
      diffs.push(`${k}: بصمة الجالب ${r.sha256.slice(0, 16)}… ≠ بصمة repair.rs ${s.sha256.slice(0, 16)}…`);
    }
  }
  if (scriptRows.length !== rustRows.length) {
    diffs.push(`العدد: الجالب ${scriptRows.length} وrepair.rs ${rustRows.length}`);
  }
  return diffs;
}

function checkParity(root) {
  const scriptPath = path.join(root, SCRIPT_REL);
  const rustPath = path.join(root, REPAIR_RS_REL);
  if (!fs.existsSync(scriptPath)) throw new GuardError(`بنية غير صالحة: ${SCRIPT_REL} غير موجود عند ${scriptPath}`);
  if (!fs.existsSync(rustPath)) throw new GuardError(`بنية غير صالحة: ${REPAIR_RS_REL} غير موجود عند ${rustPath}`);
  const scriptRows = validateTable(componentsFromScript(fs.readFileSync(scriptPath, 'utf8')), SCRIPT_REL);
  const rustRows = validateTable(componentsFromRust(fs.readFileSync(rustPath, 'utf8')), REPAIR_RS_REL);
  return { scriptRows, rustRows, diffs: compareTables(scriptRows, rustRows) };
}

// ---------------------------------------------------------------------------
// ② بيئات مصنوعة — بلا شبكة، وبلا كتابة في المستودع
// ---------------------------------------------------------------------------

const REDIST_REL = path.join('src-tauri', 'vc_redist.x64.exe');
/** أرضية الحجم في السكربت 5MB: نكتب 6MB لتمرّ، و1KB ليُقاس السقوط. */
const BIG_DUMMY = 6 * 1024 * 1024;

function writeFile(dir, rel, buf) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

/** نسخة من السكربت بجدول مكوّنات مصنوع (بصمة الملف المصنوع نفسه). */
function scriptWithFixturePins(src, rows) {
  const at = src.indexOf('const COMPONENTS = [');
  const end = src.indexOf('];', at);
  if (at < 0 || end < 0) throw new GuardError('لم أجد مصفوفة COMPONENTS في الجالب لأبني منها نسخة مصنوعة');
  const table =
    'const COMPONENTS = [\n' +
    rows
      .map((r) => `    { asset: '${r.asset}', dest: '${r.local}', subdir: '${r.subdir}', sha256: '${r.sha256}' },`)
      .join('\n') +
    '\n';
  return src.slice(0, at) + table + src.slice(end);
}

/**
 * نسخة أُعيد فيها سلوك ما قبل الإصلاح: `existsSync` ⇒ خروج بلا قراءة بصمة.
 * ويُشترط أن يقع الاستبدال **مرة واحدة** بالضبط، وإلا فالمُفسَد باطل (لم يغيّر شيئاً).
 */
function scriptWithOldSkipBehavior(src) {
  const before = [
    'if (fs.existsSync(dest)) {',
    '        await verifyExisting(dest, comp, opts);',
    '        return;',
    '    }',
  ].join('\n');
  const after = [
    'if (fs.existsSync(dest)) {',
    "        console.log(`${comp.dest} already exists, skipping download.`);",
    '        return;',
    '    }',
  ].join('\n');
  const n = src.split(before).length - 1;
  if (n !== 1) {
    throw new GuardError(
      `مُفسَد باطل: فرع الوجود في الجالب لا يطابق النصّ المتوقَّع (وجوده ${n} مرة) — ` +
        'فالمُفسَد لم يغيّر سلوكاً، وأي «نجاح» بعده كاذب'
    );
  }
  return src.split(before).join(after);
}

function runScript(scriptPath, fixtureDir, args) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fixtureDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { repo: ROOT, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--repo=')) opts.repo = path.resolve(arg.slice('--repo='.length));
    else throw new GuardError(`وسيط غير معروف: ${arg}`);
  }
  return opts;
}

const USAGE = `الاستعمال: node scripts/check-fetch-redist.cjs [--repo=<dir>]

  --repo=<dir>   جذر المستودع (افتراضاً جذر هذا الملف) — لقياس الجدولين في نسخة مصنوعة
  --help         هذه الرسالة

يقيس: تكافؤ COMPONENTS بين scripts/fetch_redist.js وsrc-tauri/src/repair.rs ·
وملفاً موجوداً ببصمة خاطئة **يسقط** (ولا يُمسّ) · وموجوداً ببصمة صحيحة يمرّ بلا تنزيل ·
وvc_redist تحت الأرضية يسقط · وصفر مدخل يفشل بصوت عالٍ.
0 = سليم · 1 = فشل · 2 = بنية/استعمال.`;

function selfcheck(work) {
  const cases = [];
  const record = (label, ok, detail) => {
    cases.push({ label, ok, detail: detail || '' });
    return ok;
  };
  const scriptPath = path.join(ROOT, SCRIPT_REL);
  const src = fs.readFileSync(scriptPath, 'utf8');
  const fixtureRoot = (name) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  /* ── environmentally-safe args: كل تشغيل موجَّه إلى منفذ ميت ── */
  const noNet = (extra) => [`--asset-url-base=${DEAD_BASE}`, ...(extra || [])];
  const redistOk = (dir) => writeFile(dir, REDIST_REL, Buffer.alloc(BIG_DUMMY, 7));

  /* Ⓐ ضابط: ملف مصنوع موجود وبصمته مطابقة ⇒ يمرّ بلا تنزيل ولا كتابة. */
  {
    const dir = fixtureRoot('control');
    const payload = Buffer.from('HaramLite fixture bytes — control\n', 'utf8');
    writeFile(dir, path.join('bin', 'ffmpeg.exe'), payload);
    redistOk(dir);
    const pinned = [{ asset: 'ffmpeg-lgpl.exe', local: 'ffmpeg.exe', subdir: 'bin', sha256: sha256OfBuf(payload) }];
    const copy = writeFile(dir, path.join('scripts', 'fetch_redist.js'), scriptWithFixturePins(src, pinned));
    const before = fs.readFileSync(path.join(dir, 'bin', 'ffmpeg.exe'));
    const res = runScript(copy, dir, noNet());
    const problems = [];
    if (res.status !== EXIT.PASS) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.PASS}`);
    for (const t of ['matches its pinned SHA-256', 'already exists (', '≥ floor']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    if (res.out.includes('Downloading')) problems.push('حاول التنزيل وملفٌ موجود مطابق');
    if (fs.existsSync(path.join(dir, 'bin', 'ffmpeg.exe.download'))) problems.push('ترك ملفاً جزئياً .download');
    if (!fs.readFileSync(path.join(dir, 'bin', 'ffmpeg.exe')).equals(before)) problems.push('غيّر بايتات ملف مطابق');
    record('Ⓐ ضابط: موجود ببصمة صحيحة ⇒ 0 بلا تنزيل ولا كتابة', problems.length === 0, problems.join(' · '));
  }

  /* Ⓑ مُفسَد: **ملف موجود ببصمة خاطئة** (العطل الأصلي) على السكربت **المشحون**.
     ولا شبكة: أي محاولة تنزيل تذهب إلى منفذ ميت بدل 434MB. */
  const wrongHashFixture = (name) => {
    const dir = fixtureRoot(name);
    const payload = Buffer.from('ليس ffmpeg — بايتات أجنبية\n', 'utf8');
    writeFile(dir, path.join('bin', 'ffmpeg.exe'), payload);
    redistOk(dir);
    return { dir, payload };
  };
  {
    const { dir, payload } = wrongHashFixture('wrong-hash');
    const before = fs.readFileSync(path.join(dir, 'bin', 'ffmpeg.exe'));
    const res = runScript(scriptPath, dir, noNet());
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'ffmpeg.exe موجود لكن بصمته لا تطابق', sha256OfBuf(payload), 'repair.rs في التطبيق يرفض']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    if (!fs.readFileSync(path.join(dir, 'bin', 'ffmpeg.exe')).equals(before)) problems.push('مسّ الملف المخالف');
    if (fs.existsSync(path.join(dir, 'bin', 'ffmpeg.exe.download'))) problems.push('ترك ملفاً جزئياً .download');
    record('Ⓑ مُفسَد: موجود ببصمة خاطئة ⇒ يسقط (ولا يُمسّ)', problems.length === 0, problems.join(' · '));
  }
  {
    const { dir } = wrongHashFixture('wrong-hash-verify');
    const res = runScript(scriptPath, dir, noNet(['--verify']));
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'بصمته لا تطابق']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓑ′ البيئة نفسها في --verify ⇒ تسقط أيضاً', problems.length === 0, problems.join(' · '));
  }

  /* Ⓒ مُفسَد: `vc_redist.x64.exe` موجود بحجم تحت الأرضية (صفحة خطأ محفوظة). */
  {
    const dir = fixtureRoot('redist-small');
    writeFile(dir, REDIST_REL, Buffer.alloc(1024, 1));
    const res = runScript(scriptPath, dir, noNet(['--verify']));
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'vc_redist.x64.exe موجود لكن حجمه 1024 bytes', 'أصغر من الأرضية']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓒ مُفسَد: vc_redist تحت أرضية الحجم ⇒ يسقط', problems.length === 0, problems.join(' · '));
  }

  /* Ⓓ صفر مدخل: مجلد بلا موارد + --verify ⇒ فشل مسمّى (لا نجاح فارغ). */
  {
    const dir = fixtureRoot('zero-nothing');
    const res = runScript(scriptPath, dir, noNet(['--verify']));
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'vc_redist.x64.exe مفقود', 'لا ينزّل شيئاً']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓓ صفر مدخل: مجلد فارغ + --verify ⇒ فشل مسمّى', problems.length === 0, problems.join(' · '));
  }
  {
    const dir = fixtureRoot('zero-components');
    redistOk(dir);
    const res = runScript(scriptPath, dir, noNet(['--verify']));
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'ffmpeg.exe مفقود']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓓ′ صفر مدخل: vc_redist وحدها وبلا مكوّنات + --verify ⇒ فشل مسمّى', problems.length === 0, problems.join(' · '));
  }

  /* Ⓔ مُفسَد: بنية غائبة (لا جالب ولا repair.rs) ⇒ فشل بنيوي 2 لا انهيار. */
  {
    const dir = fixtureRoot('no-files');
    const res = runScript(__filename, dir, [`--repo=${dir}`]);
    const problems = [];
    if (res.status !== EXIT.MISUSE) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.MISUSE}`);
    for (const t of ['✗', 'بنية غير صالحة']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓔ صفر مدخل: لا جالب ولا repair.rs ⇒ فشل بنيوي (2)', problems.length === 0, problems.join(' · '));
  }

  /* Ⓕ مُفسَد: انزياح بصمة في جدول الجالب ⇒ تكافؤ يسقط ويسمّي المكوّن والفرق. */
  {
    const dir = fixtureRoot('drift-digest');
    const rustRows = componentsFromRust(fs.readFileSync(path.join(ROOT, REPAIR_RS_REL), 'utf8'));
    const drifted = rustRows.map((r, i) => (i === 0 ? { ...r, sha256: 'f'.repeat(64) } : r));
    writeFile(dir, SCRIPT_REL, scriptWithFixturePins(src, drifted));
    fs.mkdirSync(path.dirname(path.join(dir, REPAIR_RS_REL)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, REPAIR_RS_REL), path.join(dir, REPAIR_RS_REL));
    const res = runScript(__filename, dir, [`--repo=${dir}`]);
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'بصمة الجالب', rustRows[0].asset]) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓕ مُفسَد: بصمة منزاحة في جدول الجالب ⇒ التكافؤ يسقط', problems.length === 0, problems.join(' · '));
  }

  /* Ⓖ مُفسَد: مكوّن زائد في الجالب ⇒ التكافؤ يسقط. */
  {
    const dir = fixtureRoot('drift-extra');
    const rustRows = componentsFromRust(fs.readFileSync(path.join(ROOT, REPAIR_RS_REL), 'utf8'));
    const extra = [...rustRows, { asset: 'ghost.exe', local: 'ghost.exe', subdir: 'bin', sha256: 'a'.repeat(64) }];
    writeFile(dir, SCRIPT_REL, scriptWithFixturePins(src, extra));
    fs.mkdirSync(path.dirname(path.join(dir, REPAIR_RS_REL)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, REPAIR_RS_REL), path.join(dir, REPAIR_RS_REL));
    const res = runScript(__filename, dir, [`--repo=${dir}`]);
    const problems = [];
    if (res.status !== EXIT.FAIL) problems.push(`رمز الخروج ${res.status} بدل ${EXIT.FAIL}`);
    for (const t of ['✗', 'زائد في الجالب: ghost.exe']) {
      if (!res.out.includes(t)) problems.push(`المخرَج لا يحوي «${t}»`);
    }
    record('Ⓖ مُفسَد: مكوّن زائد في الجالب ⇒ التكافؤ يسقط', problems.length === 0, problems.join(' · '));
  }

  /* Ⓠ مُفسَد على الإصلاح نفسه: **بيئة واحدة وجدول واحد**، والفارق الوحيد هو فحص
     البصمة عند الوجود. السكربت المشحون يسقط عليها، ونسخة ما قبل الإصلاح تمرّ —
     فالإصلاح هو الماسك لا شيء آخر. (ولا شبكة: الجدول مكوّن واحد، فالنسخة العمياء
     لا تجد شيئاً تنزّله — وهذا شرط صحة الحالة، وقد سقط أول تصميم لها لأن النسخة
     القديمة كانت تنزّل المكوّنات الغائبة الأخرى فتفشل لسبب آخر.) */
  {
    const problems = [];
    let oldSrc = null;
    try {
      oldSrc = scriptWithOldSkipBehavior(src);
    } catch (err) {
      problems.push(err.message);
    }
    if (oldSrc !== null) {
      const dir = fixtureRoot('mutant-pair');
      writeFile(dir, path.join('bin', 'ffmpeg.exe'), Buffer.from('بايتات أجنبية — البصمة مخالفة\n', 'utf8'));
      redistOk(dir);
      // بصمة مثبَّتة مخالفة عمداً: الملف موجود وبصمته ليست هذه.
      const pinnedWrong = [{ asset: 'ffmpeg-lgpl.exe', local: 'ffmpeg.exe', subdir: 'bin', sha256: 'f'.repeat(64) }];
      const realCopy = path.join(work, 'pair-real.js');
      fs.writeFileSync(realCopy, scriptWithFixturePins(src, pinnedWrong));
      const mutantCopy = path.join(work, 'pair-pre-fix.js');
      fs.writeFileSync(mutantCopy, scriptWithFixturePins(oldSrc, pinnedWrong));

      const resReal = runScript(realCopy, dir, noNet());
      if (resReal.status !== EXIT.FAIL) {
        problems.push(`السكربت المشحون رجع ${resReal.status} على البيئة المخالفة بدل ${EXIT.FAIL} — لا تكافؤ في الزوج`);
      }
      const resMutant = runScript(mutantCopy, dir, noNet());
      if (resMutant.status !== EXIT.PASS) {
        problems.push(`نسخة ما قبل الإصلاح رجعت ${resMutant.status} بدل ${EXIT.PASS} — ليست العمياء المتوقَّعة`);
      }
      if (!resMutant.out.includes('already exists, skipping download.')) {
        problems.push('نسخة ما قبل الإصلاح لم تطبع سلوك التخطي القديم — الطمس لم يقع');
      }
    }
    record('Ⓠ نسخة بلا فحص البصمة عند الوجود ⇒ المخالف يمرّ عليها (فالإصلاح هو الماسك)', problems.length === 0, problems.join(' · '));
  }

  return cases;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT.PASS;
  }

  /* ① التكافؤ على المستودع المقصود. */
  const { scriptRows, rustRows, diffs } = checkParity(opts.repo);
  if (diffs.length > 0) {
    console.error('✗ افتراق بين جدول الجالب وجدول التطبيق — الجالب يشحن بايتات غير التي يتحقّق منها repair.rs:');
    for (const d of diffs) console.error(`   - ${d}`);
    return EXIT.FAIL;
  }
  console.log(
    `✓ تكافؤ الجدولين: ${scriptRows.length} مكوّناً متطابقة (اسم · مسار · بصمة) بين ` +
      `${SCRIPT_REL} و${REPAIR_RS_REL}`
  );

  /* ② + ③ الحالات المصنوعة. */
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-fetch-redist-'));
  let cases;
  try {
    cases = selfcheck(work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const bad = cases.filter((c) => !c.ok);
  console.log(`\nحالات مصنوعة — ${cases.length}:`);
  for (const c of cases) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `\n      ${c.detail}`}`);
  if (bad.length > 0) {
    console.error(`\n✗ سقط ${bad.length} فحصاً من ${cases.length}`);
    return EXIT.FAIL;
  }
  console.log('✓ الجالب يتقابل مع التطبيق، ويرفض الموجود المخالف، ويقبل المطابق — ومُفسَدُه يمرّ عليه.');
  return EXIT.PASS;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`✗ ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = err instanceof GuardError ? err.code : EXIT.FAIL;
  }
}

module.exports = { componentsFromScript, componentsFromRust, compareTables, scriptWithOldSkipBehavior };
