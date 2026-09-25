/* ── خريطة تبويبات شاشة الإعدادات — **معلَنة، لا مُشتقّة** ────────────────────
 *
 * **لماذا ملفٌّ في المنتج لا في الاختبار**: هذه خريطة **عقد** (أي عنصر يعيش في
 * أي تبويب). وهي مقروءة من جهتين مستقلّتين:
 *   • `src/__tests__/settingsTabs.test.ts` — يقارنها بـ`closest('.settings-tab-panel')`
 *     في DOM المشحون (jsdom)، ويقيس مسار الإظهار لكل معرّف.
 *   • `scripts/check-layout.cjs` — يقرأها من هذا الملف نصّاً (نفس نمط قراءة
 *     `src/i18n.ts`) ويقيس **الهندسة الحقيقية** في متصفّح: `getBoundingClientRect()`
 *     لكل معرّف بعد تفعيل تبويبه.
 * فلو كانت الخريطة في ملف اختبار واحد لكان الحارس الثاني أعمى عن العقد.
 *
 * **والعلّة التي وُلدت منها**: شاشة الإعدادات كانت سبع حاويات **متداخلة** لا
 * متجاورة (حاوية `performance` لم تُغلق، فصار كل تبويب ابناً للذي قبله) ⇒
 * `showTab` يُخفي حاوية `performance` عند أي تبويب آخر، فيُخفي **الشجرة كلها**
 * ⇒ ستّة تبويبات فارغة. وحارس التكافؤ القديم قال «٦١ من ٦١» لأنه كان يقيس
 * **الوجود في DOM** لا **العرض في التبويب الصحيح** — فمرّ العطب.
 *
 * **وقاعدة الصيانة**: أي عنصر تحكّم جديد في شاشة الإعدادات يُضاف هنا وفي تبويبه؛
 * وحارس «التغطية» في الاختبار يسقط إن وُجد معرّف داخل `#settings-menu` غير
 * مصنَّف (لا في هذه الخريطة ولا في `SETTINGS_MENU_CHROME`).
 */

import type { SettingsTab } from './settingsScreen';

/** المعرّف ⇒ التبويب الذي **يجب** أن يكون فيه (يقابله `dataset.tab`). */
export const SETTINGS_TAB_MAP: Readonly<Record<string, SettingsTab>> = Object.freeze({
  // الأداء والمعالجة: القرار الذي يُحدّد **ما سيُجرَّب** (CUDA · المزوّد الفعّال ·
  // سقف الفصول) + إشعار انتهاء المعالجة.
  'setting-cuda': 'performance',
  'cuda-hint': 'performance',
  'cuda-hint-text': 'performance',
  'cuda-provider': 'performance',
  'max-jobs': 'performance',
  'setting-notify': 'performance',

  // الفصل والصيغة: خيارا الفصل والإخراج. كانا في لوحة «الإعدادات المتقدمة»
  // داخل `<main>` — صندوق لا يُفتح إلا بستّ نقرات على شارة الإصدار، وحُذف مساره
  // كاملاً (ترميزه ومعالجه وأنماطه) بعد نقل عناصره إلى هنا.
  'keep-inst': 'engine',
  'fmt-select': 'engine',

  // المراقبة التلقائية بخياراتها — ومنها حدّ الحجم وفاصل المسح
  // (`watch_size_label` · `watch_rescan_label` يقرأهما `watch.ts`).
  'setting-watch': 'watch',
  'watch-options': 'watch',
  'btn-watch-folder': 'watch',
  'watch-path': 'watch',
  'watch-mode': 'watch',
  'watch-status': 'watch',
  'btn-watch-cancel': 'watch',
  'watch-max-size': 'watch',
  'watch-rescan': 'watch',

  // التكامل مع المتصفح
  'setting-bridge': 'bridge',
  'bridge-ext-status': 'bridge',
  'bridge-ext-link': 'bridge',

  // بوت تيليجرام: المجموعة · الهوية · الأوامر · الإحصاءات
  'btn-telegram': 'telegram',
  'tg-badge': 'telegram',
  'tg-group-mode': 'telegram',
  'tg-bot-identity': 'telegram',
  'tg-identity-note': 'telegram',
  'tg-set-commands': 'telegram',
  'tg-commands-note': 'telegram',
  'tg-stats': 'telegram',
  'tg-stats-body': 'telegram',

  // التحديث والصيانة: التحديث · yt-dlp · الإصلاح · التبليغ
  'setting-autostart': 'update',
  'btn-update-check': 'update',
  'update-status': 'update',
  'btn-update-download': 'update',
  'setting-ytdlp-auto': 'update',
  'btn-upd-ytdlp': 'update',
  'ytdlp-auto-status': 'update',
  'ytdlp-local-version': 'update',
  'btn-repair-open': 'update',
  'btn-report': 'update',

  // عن البرنامج
  'btn-about': 'about',
});

/**
 * معرّفات **داخل** `#settings-menu` وليست في تبويب: إطار الشاشة نفسه.
 * `settings-tabs` شريط التبويبات، و`settings-close` زرّ الرجوع، و`settings-menu`
 * الحاوية. وهذه هي القائمة البيضاء الوحيدة المسموح بها داخل الشاشة خارج التبويبات.
 */
export const SETTINGS_MENU_CHROME: readonly string[] = Object.freeze([
  'settings-menu',
  'settings-close',
  'settings-tabs',
]);

/**
 * مفاتيح ترجمة **تُعنوِن حاوية إعدادات** — بها يُميَّز «صندوق إعدادات» من غيره،
 * فيسأل الحارس: هل في هذه الحاوية **عنصر واحد على الأقل من الخريطة**؟
 *
 * **ولماذا قائمة معلَنة**: الترميز لا يعطي إشارة بنيوية تفصل «لوحة إعدادات» من
 * أي `<div>` آخر (`#about-overlay` مثلاً عنوانُه `about_title` وليس لوحة إعدادات).
 * فالقائمة تقول أي العناوين تعدّ لوحةً — و**حارس عدم البطلان** يشترط وجود ٦ منها
 * فعلاً، فلا تُسكَت بحذف العنوان.
 *
 * **و`dlg_advanced` في القائمة عن قصد**: هو عنوان اللوحة المحذوفة. فإن أُعيدت
 * كتلة `#advanced-panel` وحدها (بلا عناصر) عاد عنوانُها، فصارت حاويةً مُعنونة
 * **بلا أي معرّف من الخريطة** ⇒ يسقط الحارس. (ولو حُذف المفتاح معها لسقط
 * `i18nParity` لاحقاً لأن `index.html` يطلبه.)
 */
export const SETTINGS_GROUP_HEADING_KEYS: readonly string[] = Object.freeze([
  'set_group_perf',
  'set_tab_engine',
  'set_group_watch',
  'set_group_integration',
  'set_group_system',
  'set_group_tools',
  'dlg_advanced',
]);

/**
 * **ولا قائمة استثناء للمسارات الميتة** — عن قصد، وكانت هنا واحدة.
 *
 * كان في `src/main.ts` ثلاثة معرّفات يناديها ولا وجود لها في `index.html`
 * (`preview-toggle` · `preview-duration` · `preview-hint` — بقايا «المعاينة
 * السريعة»، ومسجَّلة في `docs/AUDIT.md:647`). فنُقلت في الجولة الثانية معلَنةً
 * في `PRE_EXISTING_DEAD_MAIN_TS_IDS` بدل حذفها، وصار الحارس يميّز «ميت معلَن»
 * من «ميت جديد».
 * **وفي الجولة الثالثة حُذف المسار نفسه** (قرار المالك) **وحُذفت القائمة معه**:
 * قائمة استثناء تبقى بعد زوال سببها تصير **غطاءً لعطب قادم**. فالحارس اليوم
 * يشترط أن يكون **كل** `getElementById` في `src/main.ts` موجوداً في `index.html`
 * — و`src/main.ts` خالٍ من أي مسار ميت (مقيس: ٩ معرّفات، كلها تُحلّ).
 *
 * **وحدّ مُعلَن**: الحارس على `src/main.ts` وحده كما طُلب. ومسحُ `src/*.ts` كله
 * (‏`ARCHIVE/settings2-allsrc-ids.cjs`) يكشف **مسارين ميتين قائمين قبلي في
 * `src/queue.ts`** (`q-wrap` · `quality-select` — موجودان في `2181817` أيضاً ولا
 * وجود لهما في `index.html`)، **ولم يُمَسّا**: خارج نطاق جولة «المعاينة السريعة».
 */

/**
 * **العقد: كل حقل في `Settings` (الرست) له سطح تحكّم في الواجهة.**
 *
 * **لماذا وُجد هذا الحارس**: كان في `Settings` حقلان (`preview` · `preview_seconds`)
 * لواجهة «المعاينة السريعة» **لا وجود لها** — فكان تحرير `settings.json` يدوياً
 * يُغيّر ما ينفّذه `pipeline.rs` (قصّ الصوت إلى N ثانية + وسم `_preview`) بلا أي
 * سطح يضبطه المستخدم: **لغم لا ميزة**. وحُذف الحقلان ومستهلكوهما (جولة settings2
 * الرابعة). وهذا الحارس يمنع تكرار الصنف: حقل جديد في الرست بلا سطح ⇒ **يسقط**.
 *
 * **وكيف يُقاس**: يُقرأ `pub <field>:` من `src-tauri/src/settings.rs` نصّاً، فيجب
 * أن يكون كل حقل إمّا في `SETTINGS_FIELD_CONTROL` (ومعرّفه **موجود فعلاً** في
 * `index.html`)، وإمّا في `SETTINGS_FIELDS_WITHOUT_CONTROL` **بسبب مكتوب**.
 */
export const SETTINGS_FIELD_CONTROL: Readonly<Record<string, string>> = Object.freeze({
  // الشريط العلوي: اللغة (زرّ التبديل) وسجلّ الأحداث (زرّ الطيّ)
  lang: 'lang-toggle',
  log_open: 'log-toggle',
  // الأداء والمعالجة
  cuda: 'setting-cuda',
  notify: 'setting-notify',
  max_concurrent_jobs: 'max-jobs',
  // الفصل والصيغة
  keep_instrumental: 'keep-inst',
  // المراقبة
  watch_enabled: 'setting-watch',
  watch_path: 'watch-path',
  watch_mode: 'watch-mode',
  watch_max_size_mb: 'watch-max-size',
  watch_rescan_secs: 'watch-rescan',
  // التكامل
  bridge_enabled: 'setting-bridge',
  // التحديث والصيانة
  ytdlp_auto_update: 'setting-ytdlp-auto',
  // تيليجرام (اللوحة المنبثقة يفتحها `#btn-telegram` من تبويبها)
  telegram_enabled: 'setting-telegram',
  telegram_token: 'tg-token',
  telegram_user_id: 'tg-owner',
  telegram_audio_only: 'tg-audio-only',
  telegram_api_id: 'tg-api-id',
  telegram_api_hash: 'tg-api-hash',
  telegram_local_url: 'tg-local-url',
  telegram_group_mode: 'tg-group-mode',
  telegram_bot_identity: 'tg-bot-identity',
});

/**
 * حقول `Settings` **بلا سطح** — ولكلٍّ سبب مكتوب. وهي **ليست** إذناً عامّاً:
 * أي حقل جديد لا يجد مدخلاً هنا ⇒ يسقط الحارس. ومقصورة على حالتين:
 */
export const SETTINGS_FIELDS_WITHOUT_CONTROL: readonly { field: string; why: string }[] =
  Object.freeze([
    {
      field: 'autostart_asked',
      why:
        'ليست تفضيلاً بل **حالة داخلية مرّة واحدة**: يكتبها التطبيق نفسه ' +
        '(`askAutostartOnce` في integration.ts:820) كي لا يُسأل المستخدم عن التشغيل ' +
        'مع النظام مرتين. ولا معنى لسطح يضبطها.',
    },
    {
      field: 'watch_out_kind',
      why:
        'عطب قائم **مُعلَن** (اكتُشف بهذا الحارس، ولم يُصلَح ولم يُخفَ): يقرأه ' +
        '`watch_service.rs:468,519` ليقرّر نوع إخراج ملفّ المراقبة، ولا سطح له، ' +
        'و`settings.ts:133` يرسل القيمة `auto` **ثابتة** في كل دفع ⇒ فتحرير ' +
        'settings.json لا يدوم (الدفعة التالية تُعيدها). فهو إعداد بلا سطح ' +
        '**وبلا أثر دائم** — مرشّح للحذف أو لسطح حقيقي، والقرار للمالك.',
    },
  ]);

/**
 * معرّفات **خارج** الشاشة عن قصد — ولكلٍّ سببه. والحارس يشترط:
 *   • ألّا يكون أيٌّ منها داخل `<main>` (وهي مخفيّة في وضع الإعدادات)،
 *   • وألّا يتقاطع مع `SETTINGS_TAB_MAP` (فلا عنصر يفلت من التصنيف بصمت).
 */
export const SETTINGS_OUTSIDE_TABS: readonly { id: string; why: string }[] = Object.freeze([
  { id: 'lang-toggle', why: 'زرّ لغة الواجهة في الشريط العلوي: ليس قيمة إعداد (لا حقل له في `Settings`)، ويجب أن يبقى ظاهراً في الوضعين — نقله إلى تبويب «عن البرنامج» يحجبه ما لم تُفتح الشاشة (انظر styles.css: الرأس يبقى في وضع الإعدادات).' },

  { id: 'about-overlay', why: 'نافذة «حول» المنبثقة — تُفتح بـ`#btn-about` وتبقى خارج الشاشة.' },
  { id: 'about-title', why: 'عنوان نافذة «حول» المنبثقة.' },
  { id: 'about-close', why: 'زرّ إغلاق نافذة «حول» المنبثقة.' },
  { id: 'about-body', why: 'جسم نافذة «حول» المنبثقة (يملؤه aboutUpdate.ts).' },
  { id: 'about-ok', why: 'زرّ تأكيد نافذة «حول» المنبثقة.' },

  { id: 'autostart-overlay', why: 'نافذة سؤال التشغيل مع النظام — تُعرض مرّة واحدة عند الإقلاع، لا من الإعدادات.' },
  { id: 'autostart-ask-title', why: 'عنوان نافذة سؤال التشغيل مع النظام.' },
  { id: 'autostart-no', why: 'زرّ الرفض في نافذة سؤال التشغيل مع النظام.' },
  { id: 'autostart-yes', why: 'زرّ القبول في نافذة سؤال التشغيل مع النظام.' },

  { id: 'tg-overlay', why: 'لوحة بوت تيليجرام: نافذة منبثقة مستقلة (قرار موثَّق في index.html: التوكن لا يُدفن خلف مفتاحه). يفتحها `#btn-telegram` من تبويب تيليجرام.' },
  { id: 'tg-panel-title', why: 'عنوان لوحة تيليجرام المنبثقة.' },
  { id: 'tg-close', why: 'زرّ إغلاق لوحة تيليجرام المنبثقة.' },
  { id: 'tg-ok', why: 'زرّ تأكيد لوحة تيليجرام المنبثقة.' },
  { id: 'setting-telegram', why: 'مفتاح تفعيل البوت: داخل اللوحة المنبثقة معه حقول التوكن والمالك التي يحكمها.' },
  { id: 'tg-token', why: 'حقل توكن البوت — في اللوحة المنبثقة لا في شاشة الإعدادات.' },
  { id: 'tg-owner', why: 'حقل معرّف المستخدم المسموح — في اللوحة المنبثقة.' },
  { id: 'tg-audio-only', why: 'خيار «الصوت فقط» — في اللوحة المنبثقة.' },
  { id: 'tg-pair-row', why: 'صفّ رمز الاقتران — في اللوحة المنبثقة.' },
  { id: 'tg-pair-code', why: 'رمز الاقتران نفسه — في اللوحة المنبثقة.' },
  { id: 'tg-pair-new', why: 'زرّ توليد رمز اقتران جديد — في اللوحة المنبثقة.' },
  { id: 'tg-pair-copy', why: 'زرّ نسخ رمز الاقتران — في اللوحة المنبثقة.' },
  { id: 'tg-pair-hint', why: 'شرح رمز الاقتران — في اللوحة المنبثقة.' },
  { id: 'tg-status', why: 'سطر حالة البوت — في اللوحة المنبثقة.' },
  { id: 'tg-local-url', why: 'حقل خادم Bot API المحلي — في قسم «متقدمة» داخل اللوحة المنبثقة.' },
  { id: 'tg-api-id', why: 'حقل api_id — في قسم «متقدمة» داخل اللوحة المنبثقة.' },
  { id: 'tg-api-hash', why: 'حقل api_hash — في قسم «متقدمة» داخل اللوحة المنبثقة.' },

  { id: 'repair-overlay', why: 'معالج الإصلاح: نافذة منبثقة يفتحها `#btn-repair-open` من تبويب التحديث.' },
  { id: 'repair-title', why: 'عنوان نافذة الإصلاح المنبثقة.' },
  { id: 'repair-list', why: 'قائمة المكوّنات الناقصة — في نافذة الإصلاح.' },
  { id: 'repair-all', why: 'زرّ «إصلاح الكل» — في نافذة الإصلاح.' },
  { id: 'repair-cancel', why: 'زرّ «لاحقاً» — في نافذة الإصلاح.' },
  { id: 'repair-close', why: 'زرّ إغلاق نافذة الإصلاح.' },
  { id: 'repair-progress', why: 'شريط تقدّم الإصلاح — في نافذة الإصلاح.' },
  { id: 'repair-progress-wrap', why: 'وعاء شريط تقدّم الإصلاح.' },
  { id: 'repair-result', why: 'نتيجة الإصلاح — في نافذة الإصلاح.' },
]);
