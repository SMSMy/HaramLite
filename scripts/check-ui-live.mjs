#!/usr/bin/env node
// بوّابة **الواجهة الحيّة**: تقيس DOM التطبيق العامل عبر CDP وتحكم بدعاوى مسمّاة.
//
//   node ARCHIVE/verify-ui-live.mjs [--version 0.2.8] [--expect-rows N]
//
// **لماذا**: كل حرّاس الواجهة تقيس DOM مصنوعاً في jsdom، و«مرئي» عندها = «ليس `hidden`
// بالحساب». وهذه تقيس **ما يراه المالك**: التطبيق نفسه، بنسخته المبنية، على جهاز حقيقي.
// ونموذج الفشل فيها مسمّى: كل دعوى تُطبع ✓/✗ بسببها، والرمز 1 إن سقطت واحدة (فلا نجاح فارغ).
//
// تُشغَّل بعد تشغيل التطبيق بـ:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.HL_CDP_PORT || 9222);
const argv = process.argv.slice(2);
const wantVersion = (() => { const i = argv.indexOf('--version'); return i >= 0 ? argv[i + 1] : null; })();
const expectRows = (() => { const i = argv.indexOf('--expect-rows'); return i >= 0 ? Number(argv[i + 1]) : null; })();

const PROBE = `(() => {
  const vis = (el) => {
    if (!el) return false;
    for (let n = el; n; n = n.parentElement) {
      if (n.classList && n.classList.contains('hidden')) return false;
      const st = n.getAttribute && n.getAttribute('style');
      if (st && /display\\s*:\\s*none/.test(st)) return false;
    }
    return true;
  };
  const rows = [...document.querySelectorAll('#batch-list div[data-file]')];
  const empty = document.getElementById('batch-empty');
  const badge = document.getElementById('version-badge');
  const gm = document.getElementById('tg-group-mode');
  const log = document.getElementById('log-view');
  return {
    ui_loaded: !!document.getElementById('settings-menu') && !!document.getElementById('batch-list'),
    rows: rows.length,
    rows_text: rows.map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim()),
    pct_visible: [...document.querySelectorAll('#batch-list .batch-pct')].filter(vis).map((e) => e.textContent.trim()),
    bars_visible: [...document.querySelectorAll('#batch-list .batch-prog-bg')].filter(vis).length,
    empty_visible: vis(empty),
    empty_text: (empty?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    stop_visible: !document.getElementById('stop-bar').classList.contains('hidden'),
    log_text: (log?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    badge: badge ? badge.textContent.trim() : '(مفقود)',
    group_mode: gm ? gm.value : '(مفقود)',
    group_mode_in_settings: !!(gm && gm.closest('#settings-menu')),
    max_jobs_in_settings: !!document.getElementById('max-jobs')?.closest('#settings-menu'),
    fake_rows_in_text: /track_01_vocals|podcast_ep44/.test(document.body.innerText || ''),
    /* م٥: هوية البوت والإحصاءات — تُقاس أسطحها في الحالة الخاملة أيضاً */
    identity_box: (() => {
      const b = document.getElementById('tg-bot-identity');
      if (!b) return { exists: false };
      return {
        exists: true,
        in_settings: !!b.closest('#settings-menu'),
        checked: !!b.checked,
        disabled: !!b.disabled,
        note: (document.getElementById('tg-identity-note')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      };
    })(),
    stats_body: {
      exists: !!document.getElementById('tg-stats-body'),
      text: (document.getElementById('tg-stats-body')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    },
    commands_button: !!document.getElementById('tg-set-commands'),
  };
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url));
if (!target) { console.error('✗ لا صفحة تطبيق على CDP — شغّل التطبيق بمنفذ التنقيح ' + PORT); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('مهلة: ' + method)); } }, 15000); });
const ui = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
ws.close();

const fails = [];
let total = 0;
const check = (name, ok, detail) => { total++; console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : '')); if (!ok) fails.push(name); };

check('الواجهة حُمِّلت فعلاً (ليست صفحة خطأ)', ui.ui_loaded);
check('لا صفوف وهمية من الترميز في نصّ الصفحة', !ui.fake_rows_in_text, ui.fake_rows_in_text ? 'وُجد track_01_vocals/podcast_ep44' : '');
if (expectRows !== null) check(`عدد الصفوف = ${expectRows}`, ui.rows === expectRows, `المقيس ${ui.rows}`);
if (ui.rows === 0) {
  check('حالة الفراغ ظاهرة ونصّها غير فارغ', ui.empty_visible && ui.empty_text.length > 10, ui.empty_text.slice(0, 60));
  check('لا نسبة معروضة بطابور فارغ', ui.pct_visible.length === 0, ui.pct_visible.join(','));
  check('لا شريط تقدّم ظاهر بطابور فارغ', ui.bars_visible === 0, String(ui.bars_visible));
  check('شريط الإيقاف مخفيّ بطابور فارغ', !ui.stop_visible);
} else {
  check('حالة الفراغ **لا** تظهر مع صفوف قائمة', !ui.empty_visible, ui.empty_text.slice(0, 60));
}
check('لا إنذار كاذب في لوحة السجلّ', !/\[ERROR\]/.test(ui.log_text), ui.log_text.slice(0, 80));
if (wantVersion) check(`شارة الإصدار = ${wantVersion} أو فارغة`, ui.badge === 'v' + wantVersion || ui.badge === '', 'المقيس ' + ui.badge);
check('وضع المجموعات موجود داخل الإعدادات وقيمته مشروعة', ui.group_mode_in_settings && ['mentions', 'all'].includes(ui.group_mode), ui.group_mode);
check('سقف المهامّ داخل الإعدادات', ui.max_jobs_in_settings);
/* م٥: الحقول الجديدة — وجودها في الإعدادات، **ولا ادّعاء تطبيقٍ ابتداءً**، ولا أصفار مُختلقة */
check('مربّع هوية البوت داخل الإعدادات', ui.identity_box.exists && ui.identity_box.in_settings);
check('المربّع لا يُعلن تطبيقاً قبل قراءة الحالة',
  !ui.identity_box.checked, ui.identity_box.checked ? 'مُعلَّم ابتداءً' : 'غير مُعلَّم');
check('لوحة الإحصاءات لا تعرض أصفاراً مُختلقة',
  !/0\\s*(ملف|بايت)/.test(ui.stats_body.text), ui.stats_body.text.slice(0, 60) || '(فارغة)');
check('زرّ ضبط الأوامر موجود', ui.commands_button);

console.log(`\nالحصيلة: ${total - fails.length}/${total} دعوى مرّت` + (fails.length ? ' ⇒ سقطت: ' + fails.join(' · ') : ''));
process.exit(fails.length ? 1 : 0);
