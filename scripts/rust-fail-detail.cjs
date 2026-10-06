#!/usr/bin/env node
/* **تفصيل الاختبارات الساقطة: اسمها · موضعها · نصّ فشلها · وزمنها** — يُستخرَج من مخرَج
 * `cargo test` نفسه، لا يُقدَّر من العدد.
 *
 * **ولماذا هذا ملف منفصل**: البوّابة (`check-rust-baselines.cjs`) تحفظ مخرَج `cargo test`
 * كاملاً في الذاكرة ثم كانت **تطبع الملخّص وحده** («اختبارات فاشلة: ٨») ⇒ فلا يبقى في سجلّ
 * CI **سطر فشل واحد** (مقيس 2026-10-03: **صفر** مطابقة لـ`... FAILED` و**صفر** لـ`panicked at`
 * في أربعة سجلات تشغيل). وحين صارت اختبارات **متذبذبة على العدّاء** — تمرّ محلياً دائماً —
 * لم يبقَ سبيل إلى **اسم الساقط وسطر سقوطه ونصّ فشله**، **والعدّاء هو مصدر الدليل الوحيد
 * المتاح** ⇒ كانت البوّابة **تُتلف الدليل الذي يفسّر حمرتها**. وفصلُها في وحدة بلا آثار
 * جانبية يجعلها **قابلة للقياس** بحارس (‏`check-rust-fail-detail.cjs`) لا بالإيمان.
 *
 * **وهي دالة عرض لا حكم**: لا تُبدّل عتبة ولا أساساً ولا تُسقط شيئاً بنفسها.
 */
'use strict';

/**
 * @param {string} out مخرَج `cargo test` كاملاً (stdout + stderr مدموجَين)
 * @returns {Array<{name:string, location:string, message:string, elapsed:string}>}
 */
function failingTestDetail(out) {
  if (typeof out !== 'string' || out.length === 0) return [];
  const lines = out.split(/\r?\n/);
  const failed = [];
  for (const line of lines) {
    const m = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED$/);
    if (m) failed.push(m[1]);
  }
  /** سطر الفشل: `thread 'NAME' (pid) panicked at LOCATION:` ثم سطر الرسالة. */
  const panics = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^thread '([^']+)'[^p]*panicked at ([^:]+:\d+:\d+):?\s*$/);
    if (!m) continue;
    const detail = (lines[i + 1] || '').trim();
    if (!panics.has(m[1])) panics.set(m[1], { location: m[2], message: detail });
  }
  /** الزمن الفردي: `test NAME ... ok <0.12s>` — يُقرأ إن ظهر بهذه الصورة.
   *  و`cargo test` لا يطبع زمناً للاختبار **الفاشل** ⇒ الفحص يُدرجه في رسالة
   *  التأكيد نفسها (`elapsed=300.02s`)، ويُستخرَج من هنا. */
  const times = new Map();
  for (const line of lines) {
    const m = line.match(/^test\s+(\S+)\s+\.\.\.\s+\w+\s+<([\d.]+)s>/);
    if (m) times.set(m[1], m[2] + 's');
  }
  return failed.map((name) => {
    const p = panics.get(name) || {};
    // من رسالة الفشل نفسها: `elapsed=300.02s` (يُكتبها الاختبار في assert).
    const fromMsg = /elapsed=([\d.]+)s/.exec(p.message || '');
    return {
      name,
      location: p.location || '(بلا سطر panicked — قد يكون فشل تأكيد داخل test)',
      message: p.message || '(بلا رسالة)',
      elapsed: times.get(name) || (fromMsg ? fromMsg[1] + 's' : '(لم يُطبَع زمن فردي)'),
    };
  });
}

module.exports = { failingTestDetail };
