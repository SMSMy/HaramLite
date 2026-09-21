/* ── مزامنة الإعدادات الموحّدة (Sprint D1) ────────────────────────────────
 * نُقل من src/main.ts كما هو حرفياً: `type RustSettings`، وحالة الأسرار
 * (tgToken/tgApiHash — في الذاكرة فقط، ولا نسخة في localStorage)، ومرآة
 * `autostart_asked`، ومؤقّت المزامنة، وcollectSettings() وpushSettings()
 * وseedSettings().
 * لا تغيير في أي مفتاح أو صيغة localStorage: 'hl.cuda'، 'hl.notify'،
 * 'hl.preview'، 'hl.preview_seconds'، 'hl.keep_inst'، 'hl.bridge'، 'hl.tg'،
 * 'hl.tg_owner'، 'hl.tg_audio'، 'hl.tg_local'، 'hl.tg_api_id'، 'hl.watch'،
 * 'hl.watch_path'، 'hl.watch_mode'، 'hl.watch_max_mb'، 'hl.watch_rescan' —
 * ولا في مهلة pushSettings (300ms)، ولا في الأمرين (`get_settings`،
 * `set_settings`)، ولا في أسماء حقول RustSettings العشرين.
 * الوحيد المضاف: `export` ومُعيِّنات/مُوصِّلات صريحة لحالة كانت متغيّرات في
 * main.ts — لا منطق جديد ولا تغيير سلوك.
 */
import { invoke } from '@tauri-apps/api/core';
import { currentLang } from './i18n';
import { logOpenState } from './log';

/* ── unified settings sync (Sprint D1) ──────────────────────────────── */
export type RustSettings = Record<string, unknown>;
/** Telegram secrets live in memory only — never in localStorage (a second
 *  plaintext copy at rest, which also defeated sealing them in settings.json).
 *  `null` = "unknown" and tells the backend to keep what it already has. */
let tgToken: string | null = null;
let tgApiHash: string | null = null;

/** أسرار تيليجرام: بقيت في الذاكرة هنا، ويكتبها main.ts عبر هذه المُعيِّنات. */
export function setTelegramCredentials(token: string | null, apiHash: string | null): void {
  tgToken = token;
  tgApiHash = apiHash;
}

export function setTelegramToken(token: string | null): void {
  tgToken = token;
}

export function setTelegramApiHash(apiHash: string | null): void {
  tgApiHash = apiHash;
}
/** Mirror of the backend's `autostart_asked` (1.10): it lives in Rust only
 *  (no localStorage copy, like the autostart truth itself), so every
 *  unrelated pushSettings() keeps resending the known value instead of
 *  letting #[serde(default)] silently reset it to false. */
let autostartAsked = false;

/** سقف الفصول المتزامنة: **مطبَّع في الواجهة أيضاً** لا في الخلف وحده.
 *
 *  العطل: القيمة كانت تُمرَّر كما هي من `localStorage` (`Number(...) || 1`)،
 *  فقيمة دخيلة مثل `'9'` تصل إلى الخلف فيقصّها `slots::clamp_limit` إلى 2 —
 *  **بينما القائمة تعرض 1** (لأنها تقرأ `'2'` بالتساوي فقط) ⇒ تعرض الواجهة
 *  غير ما يعمل به التطبيق. فالتطبيع هنا يجعل المعروض = المُرسَل = المُنفَّذ.
 *
 *  والمقبول **1 أو 2** وحدهما (نفس مدى `slots::MAX_LIMIT`)، وما خرج عنهما
 *  يُردّ إلى **1** — وهو الافتراضيّ الآمن نفسه الذي تختاره القائمة لقيمة غير
 *  صالحة، فلا المفاجأة ولا الرفع الصامت إلى 2. */
export function clampConcurrentJobs(n: number): 1 | 2 {
  return n === 2 ? 2 : 1;
}

/** مرآة autostart_asked: كان main.ts يكتب المتغيّر مباشرة. */
export function setAutostartAsked(next: boolean): void {
  autostartAsked = next;
}

/* ── م٤: وضوح رسائل المجموعة (mentions-only) ─────────────────────────────
 * قرار المالك: الخيار للمستخدم في الإعدادات لا قرار مبرمج. ومفتاح التخزين
 * `hl.tg_group_mode` بقيمتين **وحدهما** — `mentions` (افتراضيّ) و`all` — على
 * نمط `hl.tg_audio` المجاور حرفياً. وهذه الدالة هي **مصدر الحقيقة الوحيد**
 * للتطبيع: `collectSettings()` و`wireSettings()` و`seedSettings()` كلها تمرّ
 * منها، فلا يمكن أن تعرض القائمة قيمة وتُرسل أخرى (وهو العطل الذي وقع في
 * سقف الفصول المتزامنة قبل `clampConcurrentJobs`).
 *
 * والقيمة غير المعروفة (تخزين قديم أو تعديل يدوي أو `'every'`) تُردّ إلى
 * `mentions`: **لا قيمة ثالثة** — لا في القائمة ولا في التخزين. وإرجاع
 * `mentions` هو الطرف الآمن: لا يوسّع ما يراه البوت. */
export function groupModeFrom(raw: string | null): 'mentions' | 'all' {
  return raw === 'all' ? 'all' : 'mentions';
}

let settingsSyncTimer: number | undefined;
/** Hook filled by wireWatchSettings so external settings changes can repaint. */
let refreshWatchUi: (() => void) | null = null;

/** يسجّل wireWatchSettings خطّافه هنا (كما كان يكتب المتغيّر نفسه). */
export function setRefreshWatchUi(fn: () => void): void {
  refreshWatchUi = fn;
}

/** ينادي الخطّاف إن كان مسجّلاً — نفس `refreshWatchUi?.()` السابق بالحرف. */
export function notifyWatchUiChanged(): void {
  refreshWatchUi?.();
}
export function collectSettings(): RustSettings {
  return {
    lang: currentLang(),
    cuda: localStorage.getItem('hl.cuda') === '1',
    notify: localStorage.getItem('hl.notify') === '1',
    preview: localStorage.getItem('hl.preview') === '1',
    preview_seconds: Number(localStorage.getItem('hl.preview_seconds')) || 15,
    keep_instrumental: localStorage.getItem('hl.keep_inst') === '1',
    bridge_enabled: localStorage.getItem('hl.bridge') === '1',
    // Sprint T1: Telegram bot (token + pairing live in Rust settings too).
    telegram_enabled: localStorage.getItem('hl.tg') === '1',
    // Secrets are NOT kept in localStorage (a second plaintext copy at rest,
    // which also defeated sealing them in settings.json). `null` ⇒ the backend
    // keeps its stored value; the panel loads them from Rust into memory.
    telegram_token: tgToken,
    telegram_user_id: localStorage.getItem('hl.tg_owner') || '',
    telegram_audio_only: localStorage.getItem('hl.tg_audio') === '1',
    // م٥: هوية البوت (اسم HaramLite وصورته) — بنمط `telegram_audio_only` أعلاه.
    // والحقل يُزامَن تلقائياً في الخلف عند كل `set_settings`، لكن **النتيجة
    // الصريحة** (نجح/فشل بسببه) لا تأتي إلا من `telegram_set_bot_identity`؛
    // فهذا الحقل يحفظ **اختيار المستخدم**، و`identity.applied` يقول **الواقع**.
    telegram_bot_identity: localStorage.getItem('hl.tg_identity') === '1',
    // م٤: مفتاح التخزين `hl.tg_group_mode` — مطبَّع عبر `groupModeFrom`،
    // فقيمة غير معروفة تُرسل `mentions` لا تمرّ كما هي إلى الخلف.
    telegram_group_mode: groupModeFrom(localStorage.getItem('hl.tg_group_mode')),
    telegram_local_url: localStorage.getItem('hl.tg_local') || '',
    telegram_api_id: localStorage.getItem('hl.tg_api_id') || '',
    telegram_api_hash: tgApiHash,
    log_open: logOpenState(),
    // Defaults to ON: a missing key must not silently stop the 24h yt-dlp
    // update, which is what keeps downloads working when a site changes.
    ytdlp_auto_update: localStorage.getItem('hl.ytdlp_auto') !== '0',
    // 1.10: the only field with no localStorage copy — the module mirror above
    // keeps unrelated pushes from resetting it to false via #[serde(default)].
    autostart_asked: autostartAsked,
    watch_enabled: localStorage.getItem('hl.watch') === '1',
    watch_path: localStorage.getItem('hl.watch_path') || null,
    watch_mode: localStorage.getItem('hl.watch_mode') || 'song',
    watch_out_kind: 'auto',
    watch_max_size_mb: Number(localStorage.getItem('hl.watch_max_mb')) || 2048,
    watch_rescan_secs: Number(localStorage.getItem('hl.watch_rescan')) || 60,
    // م١: سقف الفصول المتزامنة (1..=2). الافتراضي 1 = الطرف الآمن (فصلان
    // بلغا ذروة 7947 من 8192 م.ب: هامش 245 م.ب)، و2 اختيار صريح. والقصّ هنا
    // **مطبَّع** لا متروك للخلف: قيمة دخيلة (`'9'`) تُردّ إلى 1 فلا تصل قيمة
    // تخالف ما تعرضه القائمة (`clampConcurrentJobs` فوق).
    max_concurrent_jobs: clampConcurrentJobs(Number(localStorage.getItem('hl.max_jobs'))),
  };
}
export function pushSettings(): void {
  if (settingsSyncTimer) window.clearTimeout(settingsSyncTimer);
  settingsSyncTimer = window.setTimeout(() => {
    invoke('set_settings', { value: collectSettings() }).catch((e) =>
      console.error('set_settings failed', e));
  }, 300);
}

/** One-time seed: Rust settings → localStorage (fresh installs / migration). */
export async function seedSettings(): Promise<void> {
  try {
    const s = await invoke<RustSettings>('get_settings');
    if (!s || typeof s !== 'object') return;
    // 1.10: seed the autostart_asked mirror from backend truth (Rust-only field).
    if (typeof s.autostart_asked === 'boolean') autostartAsked = s.autostart_asked;
    const bools: [keyof RustSettings, string][] = [
      ['cuda', 'hl.cuda'], ['notify', 'hl.notify'], ['preview', 'hl.preview'],
      ['keep_instrumental', 'hl.keep_inst'], ['watch_enabled', 'hl.watch'],
      ['bridge_enabled', 'hl.bridge'],
      ['telegram_enabled', 'hl.tg'], ['telegram_audio_only', 'hl.tg_audio'],
    ];
    for (const [k, ls] of bools) {
      if (localStorage.getItem(ls) === null && s[k] !== undefined) {
        localStorage.setItem(ls, s[k] ? '1' : '0');
      }
    }
    const strs: [keyof RustSettings, string][] = [
      ['watch_mode', 'hl.watch_mode'], ['lang', 'hl.lang'],
      ['telegram_user_id', 'hl.tg_owner'],
      ['telegram_local_url', 'hl.tg_local'], ['telegram_api_id', 'hl.tg_api_id'],
    ];
    for (const [k, ls] of strs) {
      if (localStorage.getItem(ls) === null && typeof s[k] === 'string') {
        localStorage.setItem(ls, s[k] as string);
      }
    }
    // م٤: بذرة وضوح رسائل المجموعة — **مطبَّعة** لا منسوخة: قيمة الخلف
    // (`telegram_group_mode`) تمرّ بـ`groupModeFrom` أيضاً، فقيمة غريبة في
    // settings.json لا تُدخل قيمة ثالثة إلى localStorage.
    if (localStorage.getItem('hl.tg_group_mode') === null && typeof s.telegram_group_mode === 'string') {
      localStorage.setItem('hl.tg_group_mode', groupModeFrom(s.telegram_group_mode));
    }
    const nums: [keyof RustSettings, string][] = [
      ['preview_seconds', 'hl.preview_seconds'], ['watch_max_size_mb', 'hl.watch_max_mb'],
      ['watch_rescan_secs', 'hl.watch_rescan'],
      ['max_concurrent_jobs', 'hl.max_jobs'],
    ];
    for (const [k, ls] of nums) {
      if (localStorage.getItem(ls) === null && typeof s[k] === 'number') {
        localStorage.setItem(ls, String(s[k]));
      }
    }
    if (localStorage.getItem('hl.watch_path') === null && typeof s.watch_path === 'string') {
      localStorage.setItem('hl.watch_path', s.watch_path as string);
    }
  } catch {
    /* browser dev / backend unavailable */
  }
}
