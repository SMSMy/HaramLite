// HaramLite Bridge — YouTube content script.
// Two bar buttons, no panels, no questions asked:
//   1. Process — idle ("عالج هذا الفيديو") → click starts (video paused,
//      live % on the button) → click while busy cancels + resets → done dims
//      ("تم التجهيز") and enables Watch.
//   2. Watch — disabled until ready → enabled ("شاهد بعد إزالة الموسيقى") → click
//      applies the filter and plays (active color) → second click stops and
//      restores the original. Manual only — nothing auto-applies.
// Filtered watching: page video muted + filtered audio element, playback
// rate pinned at 1x on both sides (+ player API guard). The removed stretches
// — the silence left by muting the music — are handled per gap, MANDATORILY
// (no user option to turn it off): a NEARBY gap is SPEED UP (the audio, which
// contains no such stretch, is held while the picture's rate is raised — no
// seek at all, so no re-buffer and no frozen frame) and an isolated or long
// one is still JUMPED over, with the audio playing on untouched. Both keep
// picture and sound in step; a player that refuses the raised rate falls back
// to the jump for that gap. Drift backstop without forced sync while
// stopped, clean restore.
// 1.1.4: never rewind freely-playing audio (kickAudio was ungated on every
// play — YouTube fires play around our gap jumps; mapFullToCut is flat at the
// seam, so that write repeats the next words). Asymmetric drift. 1200ms selfSeek.
// Optional HL-SYNC tracer: localStorage['hl.synclog']='1'.
// Right-click Watch for options (gap-skip is mandatory + full reprocess).
// 2s fading toast.
// No chunk streaming, no time-stretching, no telemetry — local only.
// No trackers. All communication goes through Native Messaging.

(() => {
  const BTN_PROC = 'haramlite-yt-proc';
  const BTN_WATCH = 'haramlite-yt-watch';
  const BTN_MODE = 'haramlite-yt-mode';
  const MENU_ID = 'haramlite-yt-watchmenu';
  const MODE_MENU_ID = 'haramlite-yt-modemenu';
  const TOAST_ID = 'haramlite-toast';

  const T = {
    panel: 'rgba(31,29,27,0.97)', border: '#2E2C29',
    accent: '#DA7756', text: '#F5F2ED', sub: '#A38C85', ok: '#5DDAC8', err: '#FFB4AB',
  };

  /* ── i18n: كائن ثابت، لا بناء ديناميكي ──────────────────────────────────────
   * §٢٦ يمنع تركيب النصوص (نصّ + نصّ · `].join(` · eval · وصول محسوب)، وهذا الجدول
   * **كائن ثابت** على نمط STAGE_AR القائم في popup.js: كل نصّ واجهة عربي في هذا
   * الملف يحمل مفتاحاً، وقيمته نصّ حرفيّ واحد لكل لغة. لا يُبنى منه شيء وقت التشغيل.
   *
   * والعربية **مرجع التغطية**: الحارس check-extension-i18n.cjs يمسح هذا الملف
   * بالمرشّح الواسع (أي نصّ يحمل محرفاً عربياً واحداً، والمختلط مثل
   * «HaramLite — جاهز للمشاهدة» عربيٌّ عند مستخدم إنجليزي) ويُسقط أيّ نصّ عربي
   * خارج هذا الجدول، ويفرض تكافؤ المفاتيح في الاتجاهين.
   *
   * واختيار اللغة بلا مفتاح تخزين جديد (§٢٧ يقفل localStorage على 'hl.synclog') وبلا
   * chrome.i18n وبلا _locales (مقيس: لا وجود لهما في هذا المشروع ولا في المانيفست)
   * ⇒ الاختيار من `navigator.language`/`navigator.languages` وهو **لغة واجهة
   * المتصفح** لا لغة الصفحة، وهذا هو الصواب: مستخدم إنجليزي يشاهد فيديو عربياً
   * يجب أن يرى واجهة إنجليزية، والعكس.
   */
  const I18N = {
    ar: {
      // أزرار الشريط
      'btn.proc.idle': 'عالج هذا الفيديو',
      'btn.proc.workingTitle': 'HaramLite — جارٍ العمل (نقرة للإلغاء)',
      'btn.proc.done': 'تم التجهيز ✓',
      'btn.proc.doneTitle': 'HaramLite — جاهز للمشاهدة',
      'btn.proc.idleTitle': 'HaramLite — معالجة هذا الفيديو على جهازك',
      'btn.watch.ready': 'شاهد بعد إزالة الموسيقى ▶',
      'btn.watch.readyTitle': 'HaramLite — مشاهدة مفلترة',
      'btn.watch.stop': '⏸ إيقاف',
      'btn.watch.stopTitle': 'HaramLite — إيقاف المشاهدة المفلترة',
      'btn.watch.fetching': 'جارٍ الجلب…',
      'btn.watch.fetchingTitle': 'HaramLite — جلب الصوت المفلتر',
      'btn.watch.disabledTitle': 'HaramLite — يفعَّل بعد التجهيز',
      'btn.watch.fetchingPct': 'جارٍ الجلب… {pct}%',
      // اختيار الوضع من الصفحة (بلاغ المالك 2026-09-23: لا زرّ في المشغّل يفرّق
      // بين «أغنية» و«مقطع») — الزرّ يعرض الوضع الحالي، ونقرته تفتح قائمة الوضعين.
      'btn.mode.song': '🎵 أغنية',
      'btn.mode.clip': '🎬 مقطع',
      'btn.mode.title': 'HaramLite — اختر نوع المعالجة (أغنية أو مقطع)',
      'mode.title': 'نوع المعالجة',
      'menu.song': '🎵 أغنية — فصل كامل + قصّ الصمت',
      'menu.clip': '🎬 مقطع — إزالة الموسيقى وحدها',
      // قائمة النقر الأيمن
      'menu.reprocess': '↻ معالجة كاملة',
      // نسخة أخرى من الإضافة تملك أزرار الصفحة (تعايش مقيس: معرّف الزرّ ثابت)
      'foreign.bar': 'نسخة أخرى من إضافة HaramLite مفعَّلة وتحرس أزرار هذا المشغّل — عطّلها من chrome://extensions ثم أعد تحميل الصفحة، وإلا فالإلغاء والوضع لا يعملان من هذه النسخة',
      // الجسر
      'bridge.noResponse': 'فشل الاتصال',
      // بدء المعالجة
      'start.sendFailed': 'فشل الإرسال',
      'start.received': '✓ استُلم الرابط — بدء التنزيل...',
      'cancel.done': '⏹ أُلغيت المعالجة — اضغط للبدء من جديد',
      // نتيجة الاستطلاع
      'poll.ok': 'تم التجهيز ✓ — شاهد بعد إزالة الموسيقى ▶',
      'poll.failed': 'فشلت المعالجة',
      'poll.bridgeLost': '⚠ انقطع الاتصال بتطبيق HaramLite — شغّل التطبيق وفعّل التكامل ثم أعد المحاولة',
      // جلب الصوت المفلتر
      'fetch.emptyReply': 'رد فارغ من التطبيق — أعد المحاولة',
      'fetch.partialFile': 'ملف ناقص — أعد المحاولة',
      'fetch.failed': 'تعذر الجلب',
      'fetch.decodeFailed': 'تعذر قراءة الصوت المفلتر',
      'fetch.unsupported': 'صيغة غير مدعومة في المتصفح',
      // سطر المشاهدة
      'watch.line': '▶ مشاهدة مفلترة — الصوت من المعالجة المحلية',
      'watch.lineAgo': '▶ مشاهدة مفلترة — الصوت من المعالجة المحلية (عولجت في {s} ث)',
      // المشاهدة
      'watch.needMap': '✗ ابنِ الخريطة أولاً — اضغط «عالج هذا الفيديو»',
      'watch.noVideo': '✗ لم يُعثر على فيديو الصفحة',
      'watch.mapMissing': '✗ إخراج مقصوص الصمت بلا خريطة — اطلب المعالجة من جديد',
      'watch.playAudio': '▶ اضغط تشغيل لبدء الصوت المفلتر',
      'watch.playVideo': '▶ اضغط تشغيل الفيديو لبدء المشاهدة',
      'watch.stopped': '⏹ توقفت المشاهدة — عاد صوت الصفحة الأصلي',
      // رموز خطأ التطبيق المستقرّة (`code` في عقد الجسر — م٦-ج).
      // والعطل المقيس: نصوص التطبيق تصل عربية فتُعرض في واجهة إنجليزية؛ فهذه
      // المداخل هي ترجمتها بالرمز، ويحرس التقابل `scripts/check-bridge-codes.cjs`.
      // و`{e}` في `code.engine_error`: التفصيل الخام من المحرّك، ويُملأ بـ`fill`.
      'code.duplicate_link': 'هذا الرابط طُلب من قبل في هذه الجلسة — تخطي المكرر',
      'code.cancelled_by_user': 'أُلغيت المعالجة من قبل المستخدم',
      'code.download_cancelled': 'أُلغي التنزيل من قبل المستخدم',
      'code.internal_error': 'عطل داخلي — أعد المحاولة',
      'code.engine_error': 'فشل المحرّك: {e}',
      'code.unknown_message': 'رسالة غير معروفة بين الإضافة والتطبيق',
      'code.bad_input': 'طلب غير صالح',
    },
    en: {
      'btn.proc.idle': 'Process this video',
      'btn.proc.workingTitle': 'HaramLite — working (click to cancel)',
      'btn.proc.done': 'Ready ✓',
      'btn.proc.doneTitle': 'HaramLite — ready to watch',
      'btn.proc.idleTitle': 'HaramLite — process this video on your machine',
      'btn.watch.ready': 'Watch without music ▶',
      'btn.watch.readyTitle': 'HaramLite — watch filtered',
      'btn.watch.stop': '⏸ Stop',
      'btn.watch.stopTitle': 'HaramLite — stop filtered watching',
      'btn.watch.fetching': 'Fetching…',
      'btn.watch.fetchingTitle': 'HaramLite — fetching the filtered audio',
      'btn.watch.disabledTitle': 'HaramLite — enabled after processing',
      'btn.watch.fetchingPct': 'Fetching… {pct}%',
      'btn.mode.song': '🎵 Song',
      'btn.mode.clip': '🎬 Clip',
      'btn.mode.title': 'HaramLite — choose what to process (song or clip)',
      'mode.title': 'Processing mode',
      'menu.song': '🎵 Song — full separation + silence trimming',
      'menu.clip': '🎬 Clip — remove the music only',
      'menu.reprocess': '↻ Full reprocess',
      'foreign.bar': 'Another copy of the HaramLite extension is enabled and owns this player’s buttons — disable it in chrome://extensions, then reload the page; otherwise cancel and mode will not work from this copy',
      'bridge.noResponse': 'Connection failed',
      'start.sendFailed': 'Send failed',
      'start.received': '✓ Link received — starting the download...',
      'cancel.done': '⏹ Processing cancelled — press to start again',
      'poll.ok': 'Ready ✓ — watch without music ▶',
      'poll.failed': 'Processing failed',
      'poll.bridgeLost': '⚠ Lost connection to the HaramLite app — run the app, enable the integration, then retry',
      'fetch.emptyReply': 'Empty reply from the app — retry',
      'fetch.partialFile': 'Incomplete file — retry',
      'fetch.failed': 'Fetch failed',
      'fetch.decodeFailed': 'Could not read the filtered audio',
      'fetch.unsupported': 'Format not supported in this browser',
      'watch.line': '▶ Filtered watching — audio from local processing',
      'watch.lineAgo': '▶ Filtered watching — audio from local processing (processed in {s}s)',
      'watch.needMap': '✗ Build the map first — press «Process this video»',
      'watch.noVideo': '✗ No page video found',
      'watch.mapMissing': '✗ Silence-cut output without a map — request processing again',
      'watch.playAudio': '▶ Press play to start the filtered audio',
      'watch.playVideo': '▶ Press play on the video to start watching',
      'watch.stopped': '⏹ Watching stopped — the page audio is back',
      'code.duplicate_link': 'This link was already requested in this session — skipping the duplicate',
      'code.cancelled_by_user': 'Processing was cancelled by the user',
      'code.download_cancelled': 'The download was cancelled by the user',
      'code.internal_error': 'Internal error — try again',
      'code.engine_error': 'Engine failed: {e}',
      'code.unknown_message': 'Unknown message between the extension and the app',
      'code.bad_input': 'Invalid request',
    },
  };

  /* اختيار اللغة: دالّة **نقية** (قائمة لغات ⇒ لغة مدعومة) ليستخرجها الحارس
   * ويختبرها بمدخلات مصنوعة بلا متصفّح — كما تُستخرج بقية الدوال النقية.
   *
   * والقائمة تُقرأ **بترتيب المتصفح** (`navigator.languages` مرتَّبة بتفضيل
   * المستخدم) فيُختار أول لغة مدعومة فيها. مقصود: من ضبط [fr, ar] لا نُلبسه
   * الإنجليزية وهو قد أعلن أنه يقرأ العربية؛ ومن ضبط [de, en] يأخذ الإنجليزية.
   * وإن لم تكن في القائمة عربية ولا إنجليزية ⇒ **الإنجليزية** (لغة المتصفح
   * الافتراضية في المتجر، والعربية تُدرَج صريحةً فتصل لأهلها).
   */
  function pickLang(list) {
    const arr = Array.isArray(list) ? list : [list];
    for (const raw of arr) {
      if (typeof raw !== 'string') continue;
      const tag = raw.toLowerCase();
      if (tag === 'ar' || tag.indexOf('ar-') === 0) return 'ar';
      if (tag === 'en' || tag.indexOf('en-') === 0) return 'en';
    }
    // لغة غير عربية ولا إنجليزية (فرنسية · تركية · …) ⇒ الإنجليزية.
    return 'en';
  }
  /* اللغة: **الافتراضيّ لغة واجهة المتصفّح** كما كان بالضبط (لا يكسر السلوك
   * القائم ولا اختبارات `pickLang`)، و**تفضيل صريح** من النافذة يغلبه: مفتاح
   * `hl.lang` في `chrome.storage.local` — بلاغ المالك (2026-09-23): «زر اللغة
   * بالإضافة لم أجده حتى أحوّله إلى اللغة الإنجليزية».
   *
   * و`localStorage` **لا يصلح لحمل هذا التفضيل**: `content.js` يعمل في أصل
   * **الصفحة** (`youtube.com`) لا في أصل الإضافة، فقراءة ما كتبته النافذة منه
   * مستحيلة — ولذلك `chrome.storage` (يقرأه الطرفان ويُشعِر بالتغيّر).
   */
  let LANG = pickLang(
    (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [(typeof navigator !== 'undefined' && navigator.language) || 'en']
  );
  let RTL = LANG === 'ar';
  /** اللغة المخزَّنة الصالحة: `ar`/`en` فقط — وأي شيء آخر (أو غياب) ⇒ بلا تفضيل. */
  function storedLang(value) {
    return (value === 'ar' || value === 'en') ? value : null;
  }
  /** نصّ الواجهة بمفتاحه. مفتاح مجهول ⇒ العربية (المرجع) لا فراغ. */
  function t(key) {
    const row = I18N[LANG] || I18N.ar;
    return (key in row) ? row[key] : I18N.ar[key];
  }
  /** {pct} · {s} — استبدال موضعي لنصّ **من الجدول**، بلا تركيب نصّ جديد. */
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

  /* نصّ خطأ التطبيق: **الترجمة برمزه المستقرّ** `code`، وإلا فالنصّ الخام كما هو.
   *
   * والعقد (م٦-ج): التطبيق يُصدر `{ ok:false, error:<نصّه كما هو>, code:<رمز> }`،
   * فالقارئ القديم يقرأ `error` ويتجاهل ما لا يعرفه، وهذا القارئ يترجم بالرمز —
   * فالنصّ العربي لا يظهر في واجهة إنجليزية. ورمز **مجهول** (تطبيق أحدث من
   * الإضافة) يقع على `error` الخام: توافق خلفي، ولا فراغ ولا خطأ مكتوم.
   *
   * والربط **جدول ثابت**: رمز ⇒ مفتاح `code.<رمز>` في `I18N` أعلاه، وكلٌّ بمفتاح
   * نصّ حرفيّ (§٢٦ يمنع المفتاح المحسوب). ويحرس التقابل في الاتجاهين
   * `scripts/check-bridge-codes.cjs`: رمز في الرست بلا مدخل هنا يُسقطه، ومدخل
   * هنا بلا رمز في الرست يُسقطه، وموضع خطأ في الرست لا يمرّر رمزاً يُسقطه.
   *
   * والاتجاه **لا يُشتقّ من هذا النصّ** بل من `RTL` (اللغة المُختارة)، فالعربية
   * الخام في واجهة إنجليزية تبقى `ltr` — القاعدة المُعلَنة، لا استنتاج من المحتوى.
   */
  function errText(err, fallback) {
    const raw = String((err && (err.message || err.error)) || fallback || '');
    switch ((err && err.code) || '') {
      case 'duplicate_link': return t('code.duplicate_link');
      case 'cancelled_by_user': return t('code.cancelled_by_user');
      case 'download_cancelled': return t('code.download_cancelled');
      case 'internal_error': return t('code.internal_error');
      case 'engine_error': return fill(t('code.engine_error'), { e: raw });
      case 'unknown_message': return t('code.unknown_message');
      case 'bad_input': return t('code.bad_input');
      default: return raw;
    }
  }

  let procBtn = null;
  let watchBtn = null;
  let modeBtn = null;
  let menuCloser = null;
  let modeCloser = null;
  let toastTimer = 0;
  let BUSY = false;
  let LAST = null;
  let WATCH = null;
  let SENT_URL = null;
  /* حالة الأزرار المعروضة **مسجَّلة** لا مشتقّة: مبدّل اللغة (بند ٤) يحتاج إعادة
   * رسم ما هو معروض الآن بمفاتيح اللغة الجديدة، ولو أُعيد الرسم من `BUSY`/`LAST`
   * وحدهما لضاع رقم النسبة المعروض (`setProc('working', pct)`) فيُقرأ 0%. */
  let PROC_VIEW = { state: 'idle', pct: 0 };
  let WATCH_VIEW = 'disabled';
  /* وضع المعالجة المختار من الصفحة (بند ٣): `song` أو `clip`، ويُحفظ في
   * `chrome.storage.local['hl.popup.mode']` — **المفتاح نفسه** الذي تكتبه النافذة،
   * فيتفق السطحان على تفضيل واحد بدل تفضيلين يتناقضان. والافتراضيّ `clip` كما في
   * النافذة (`popup.js` — `let mode = 'clip'`). */
  let MODE = 'clip';

  /* ── `chrome.storage.local`: اللغة والوضع — وصفر سقوط إن غاب الـAPI ─────────
   * الحارس البنيوي (`scripts/check-extension-i18n.cjs`) يعدّ مفاتيح `localStorage`
   * **بالاسم**؛ وهذان المفتاحان في `chrome.storage` لا في `localStorage` (السبب
   * في تعليق اللغة أعلاه)، فيُعلَنان في `TARGETS` بالاسم نفسه مع تعليلهما.
   * و`chrome.storage` غير متاح في كل بيئة قياس (شيم الحارس)، فالقراءة **مُسيَّجة**
   * بـ`try` وبفحص وجود الواجهة: غيابها يعني «لا تفضيل» لا انهيار السكربت كله.
   */
  function readPrefs(keys, cb) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { cb({}); return; }
      chrome.storage.local.get(keys, (got) => cb(got || {}));
    } catch (e) {
      cb({});
    }
  }
  function applyPrefs(got) {
    const l = storedLang(got && got['hl.lang']);
    if (l) applyLang(l);
    const m = got && got['hl.popup.mode'];
    if (m === 'song' || m === 'clip') MODE = m;
    paintModeBtn();
  }
  readPrefs(['hl.lang', 'hl.popup.mode'], applyPrefs);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes) => {
        // النافذة غيّرت اللغة ⇒ الصفحة تتبعها فوراً (بلاغ المالك: المبدّل «يتبعه
        // content.js أيضاً»). و`applyPrefs` تتجاهل ما لم يتغيّر فعلاً.
        if (changes && (changes['hl.lang'] || changes['hl.popup.mode'])) {
          const next = {};
          if (changes['hl.lang']) next['hl.lang'] = changes['hl.lang'].newValue;
          if (changes['hl.popup.mode']) next['hl.popup.mode'] = changes['hl.popup.mode'].newValue;
          applyPrefs(next);
        }
      });
    }
  } catch (e) { /* بلا `chrome.storage` — لا تتبّع، ولا انهيار */ }

  /** يعرض لغةً مختارة على الصفحة: تُعيد رسم المعروض بمفاتيحها **واتجاهه**. */
  function applyLang(next) {
    if (next !== 'ar' && next !== 'en') return;   // قيمة غريبة ⇒ لا تغيير
    if (next === LANG) return;
    LANG = next;
    RTL = next === 'ar';
    closeWatchMenu();
    closeModeMenu();
    repaintBar();
  }
  /** الاتجاه المُشتقّ من اللغة — يُسند إلى **كل** سطح يرسمه هذا الملف. */
  function dirNow() { return RTL ? 'rtl' : 'ltr'; }
  /* إعادة رسم ما هو معروض (لا إنشاء جديد): الأزرار بحالتها المسجَّلة **وباتجاهها**.
   *
   * **والاتجاه يُعاد إسناده هنا صراحةً** — وهذا إصلاح عطل قِيس بجاسوس مستقلّ على
   * `2b1d8c2`: `barBtnBase()` هي الوحيدة التي تُسند `direction`، وتُنادى في مواضع
   * **الإنشاء** الثلاثة وحدها، فإعادة الرسم كانت تُغيّر النصّ **وتترك `direction`
   * القديم** ⇒ يعود عيب bidi نفسه من باب التبديل الحيّ (نصّ إنجليزي في حاوية
   * `rtl`). القياس: إقلاع بمخزَّن `ar` ⇒ `{procDir:"rtl",watchDir:"rtl",modeDir:"rtl"}`،
   * ثم تبديل حيّ إلى `en` ⇒ النصّ `"Process this video"` والاتجاهات **`rtl` كما هي**.
   * (وهو نفس صنف العطل الذي يقول تعليق `barBtnBase` إنه أُصلح — فلا يجوز أن يعود
   * من مسار التبديل.) */
  function repaintBar() {
    setProc(PROC_VIEW.state, PROC_VIEW.pct);
    setWatchBtn(WATCH_VIEW);
    paintModeBtn();
    for (const b of [procBtn, watchBtn, modeBtn]) {
      if (b) b.style.direction = dirNow();
    }
  }

  /* ── قفل الإلغاء (بند ١أ) ────────────────────────────────────────────────────
   * العطل المقيس (سجلّ التطبيق `haramlite.log.2026-09-23`): إلغاء عند
   * `10:39:53.609` ثم `طلب من المتصفح: …AJOOve4s0_8` عند `10:39:53.616` — **٧ مللي**
   * بعده — ثم `watch-temp request` فمهمّة كاملة «أُلغيت: false» ونغمة انتهاء.
   *
   * والسطر `watch-temp request` **يحسم المُرسِل**: `bridge.rs:1097` لا يطبعه إلا على
   * مسار `watch`، و`job_watch_of` (`bridge.rs:817-820`) لا يجعله صحيحاً إلا بـ
   * `mode == "watch"` — وهذا الحقل كان يُرسله في 1.1.8 **موضع واحد فقط**:
   * `startFull()` في هذا الملف. و`doCancel()` هي المسار الوحيد إلى `cancel`، ومن
   * `resetBar()` تُصفّر `BUSY` **متزامنةً** ⇒ الزرّ يعود «عالج هذا الفيديو» في اللحظة
   * نفسها، فالنقرة الثانية من **الإيماءة الفيزيائية نفسها** (نقرة مزدوجة، أو نقرة
   * «لم يستجب؟» بعد رؤية الزرّ عاد) تُرسل طلباً جديداً للرابط نفسه — وهو ما يُحيي
   * مهمّة في طابور التطبيق بعد تفريغه بالإلغاء.
   *
   * فالقفل: بعد الإلغاء يُرفض البدء مدة `CANCEL_LATCH_MS`، وهي **أطول من مهلة
   * النقر المزدوج في ويندوز** (٥٠٠ مللي افتراضاً) فلا تعبرها نقرة مزدوجة، وأقصر من
   * أن تُناقض نصّ الإلغاء المعروض («اضغط للبدء من جديد» يبقى صادقاً: ضغطة ثانية
   * واعية بعد انقضاء القفل تبدأ من جديد).
   */
  const CANCEL_LATCH_MS = 900;
  let CANCELLED_AT = 0;
  /* وعلم البدء: يُسند **متزامنةً قبل `await`** في `startFull` فلا يمرّ طلب ثانٍ من
   * نقرة مزدوجة قبل أن يُسند `BUSY` (التعليل الكامل في `startFull`). */
  let STARTING = false;
  /* نسخة **أخرى** من الإضافة تحقن في الصفحة نفسها: معرّف الزرّ ثابت
   * (`haramlite-yt-proc`) في 1.1.5 وفي نسختنا (قِيس بالقراءة في
   * `Extensions\kaijaffkolenjhfcbaepmjndheahhikg\1.1.5_0\content.js:29`)، وكلتاهما
   * تنسحب إن وجدت المعرّف ⇒ **أول من يحقن يفوز** والثانية تصمت. فإذا وجدنا الزرّ
   * ولا نملكه (`procBtn === null`) فالمالك نسخة أخرى — ونُبلغ المالك في صفحته بدل
   * الصمت (بلاغه اليوم قِيس على جهاز فيه 1.1.5 من المتجر مفعَّلة مع نسختنا). */
  let FOREIGN_BAR = false;
  let foreignTold = false;

  // Match a completion to THIS page by video identity — output FILE names
  // derive from video titles (not ids), so name-matching would misfire.
  function vidOf(u) {
    if (!u || typeof u !== 'string') return null;
    let m = u.match(/[?&]v=([^&#]+)/);
    if (m) return m[1];
    m = u.match(/youtu\.be\/([^?&#/]+)/);
    if (m) return m[1];
    m = u.match(/\/(shorts|embed|live)\/([^?&#/]+)/);
    if (m) return m[2];
    return null;
  }
  function sameVideo(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const va = vidOf(a);
    const vb = vidOf(b);
    return !!va && va === vb;
  }

  /** خطأ الجسر: النصّ كما هو ومعَه رمزه المستقرّ `code` إن حمله الردّ. */
  function bridgeError(resp) {
    const e = new Error((resp && resp.error) || t('bridge.noResponse'));
    if (resp && typeof resp.code === 'string') e.code = resp.code;
    return e;
  }

  function native(msg) {
    return new Promise((resolve, reject) => {
      // sendNativeMessage is not available to content scripts — proxy
      // through the background service worker.
      chrome.runtime.sendMessage({ type: 'native', message: msg }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!resp || !resp.ok) reject(bridgeError(resp));
        else resolve(resp.resp || {});
      });
    });
  }

  /* ── fading toast ──────────────────────────────────────────────── */
  function toast(msg, ms) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.style.cssText =
        `position:fixed;bottom:72px;right:16px;z-index:2147483002;max-width:min(360px,90vw);` +
        `background:rgba(21,19,17,.96);border:1px solid ${T.border};border-radius:10px;` +
        `padding:8px 12px;color:${T.text};font-family:Roboto,Arial,sans-serif;` +
        `font-size:12px;direction:${RTL ? 'rtl' : 'ltr'};transition:opacity .4s;`;
      document.body.appendChild(el);
    }
    // والاتجاه يتبع **اللغة** لا النصّ: نصّ خام من تطبيق أحدث قد يكون عربياً في
    // واجهة إنجليزية، فلا يُقلب اتجاه الواجهة تبعاً له (القاعدة نفسها في الجدول).
    el.style.direction = RTL ? 'rtl' : 'ltr';
    el.textContent = msg;
    el.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, ms || 2000);
  }

  /* ── bar buttons ───────────────────────────────────────────────── */
  /** عنصر من وسمه، بنمطه، ونصّه — **بلا `innerHTML` إطلاقاً**.
   *  والسبب **مقيس حيّاً** (كروم 153 على `www.youtube.com` و`music.youtube.com`
   *  الحقيقيين): يوتيوب يفرض سياسة **Trusted Types**، فإسناد `innerHTML` يرمي
   *  `TypeError: Failed to set the 'innerHTML' property on 'Element': This document
   *  requires 'TrustedHTML' assignment.` ⇒ كل قائمة كانت تُبنى بـ`innerHTML` **لم
   *  تكن تُفتح على يوتيوب إطلاقاً** (قائمة النقر الأيمن القائمة، وقائمة الوضع الجديدة).
   *  ولم يرَ ذلك أيّ حارس `jsdom` (لا يفرض Trusted Types) — فالقاعدة الآن بنيوية:
   *  لا `innerHTML` في هذا الملف، ويعدّها `scripts/check-extension-sync.cjs`.
   *  و`textContent` لا يُفسَّر كوسم فلا مسار حقن أصلاً. */
  function mkNode(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text !== null && text !== undefined) n.textContent = text;
    return n;
  }
  function barBtnBase() {
    // والاتجاه **يُضبط صريحاً** كالتوست والقائمة: بدونه يرث الزرّ اتجاه **الصفحة**،
    // فعلى يوتيوب عربي (`dir="rtl"`) بواجهة إنجليزية يأخذ الزرّ RTL ⇒ خلل bidi في
    // «Watch without music ▶». (عيب أثبته جاسوس مستقلّ بغياب `btn.style.direction`.)
    return `direction:${RTL ? 'rtl' : 'ltr'};` +
      'display:inline-flex;align-items:center;justify-content:center;' +
      'font-family:Roboto,Arial,sans-serif;font-size:13px;font-weight:600;white-space:nowrap;' +
      'border:1px solid transparent;border-radius:16px;padding:0 14px;margin:0 4px;cursor:pointer;' +
      'width:auto;height:32px;vertical-align:middle;box-sizing:border-box;transition:all 0.2s;' +
      'background:rgba(21,19,17,.94);box-shadow:0 1px 8px rgba(0,0,0,.55);' +
      'text-shadow:0 1px 2px rgba(0,0,0,.7);';
  }
  function makeProcBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_PROC;
    btn.type = 'button';
    btn.className = 'ytp-button';
    btn.setAttribute('aria-label', 'HaramLite: download and process');
    btn.style.cssText = barBtnBase();
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (BUSY) doCancel();
      // زرّ المعالجة/المشاهدة ⇒ **مسار مؤقّت** بعلم مشاهدة (لا `mode`).
      else void startFull('watch');
    });
    return btn;
  }
  /* ── زرّ اختيار الوضع (بند ٣) ────────────────────────────────────────────────
   * بلاغ المالك: «لا يوجد زر في المشغل باليوتيوب لاختيار هل هو مقطع عادي أو أغنية».
   * فزرّ ثالث في الشريط يعرض **الوضع الحالي** بنصّه، ونقرته تفتح قائمة صغيرة
   * بالوضعين؛ واختيار أحدهما يحفظه في `chrome.storage.local['hl.popup.mode']`
   * (المفتاح نفسه الذي تكتبه النافذة) ثم يبدأ المعالجة بذلك الوضع.
   */
  function makeModeBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_MODE;
    btn.type = 'button';
    btn.className = 'ytp-button';
    btn.style.cssText = barBtnBase();
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (BUSY) { toggleModeMenu(btn); return; }   // أثناء العمل: القائمة للعلم فقط
      toggleModeMenu(btn);
    });
    return btn;
  }
  function paintModeBtn() {
    if (!modeBtn) return;
    modeBtn.textContent = MODE === 'song' ? t('btn.mode.song') : t('btn.mode.clip');
    modeBtn.title = t('btn.mode.title');
    modeBtn.setAttribute('aria-label', modeBtn.title);
  }
  function closeModeMenu() {
    document.getElementById(MODE_MENU_ID)?.remove();
    if (modeCloser) {
      document.removeEventListener('click', modeCloser);
      modeCloser = null;
    }
  }
  function toggleModeMenu(anchor) {
    if (document.getElementById(MODE_MENU_ID)) { closeModeMenu(); return; }
    closeWatchMenu();
    const r = anchor.getBoundingClientRect();
    const menu = mkNode('div', null);
    menu.id = MODE_MENU_ID;
    menu.style.cssText =
      `position:fixed;bottom:${window.innerHeight - r.top + 8}px;right:${window.innerWidth - r.right}px;` +
      `min-width:210px;background:${T.panel};border:1px solid ${T.border};border-radius:10px;` +
      `box-shadow:0 10px 28px rgba(0,0,0,.55);padding:8px;z-index:2147483003;` +
      `font-family:Roboto,Arial,sans-serif;font-size:12px;direction:${RTL ? 'rtl' : 'ltr'};color:${T.text};`;
    // عنوان القائمة ثم مدخلان — **يُبنيان بعقد DOM لا بـ`innerHTML`** (التعليل في
    // تعليق `mkNode`)، ونصّاهما **من الجدول** (`menu.song`/`menu.clip`) فلا نصّ
    // عربي خارج `I18N`، والوسم «✓» عقدة نصّية مستقلّة بلا تركيب نصّ.
    menu.appendChild(mkNode('div', `padding:2px 6px 6px;color:${T.sub};font-size:11px;`, t('mode.title')));
    const entryCss = (on) =>
      `width:100%;padding:8px 6px;background:transparent;border:none;color:${on ? T.text : T.sub};` +
      `font-size:12px;text-align:${RTL ? 'right' : 'left'};cursor:pointer;`;
    /* المدخلان: **المفتاح نصّ حرفيّ في موضع النداء** (`t('menu.song')`) والنصّ
     * يُمرَّر جاهزاً إلى الباني — ولا مفتاح محسوب: §٢٦ يمنع `t(key)` بمتغيّر لأنه
     * يُخفي النصّ عن حارس التعريب فتصير مفاتيح الجدول «ميتة» بلا تغطية (قِيس:
     * نسخة أولى بـ`t(key)` أسقطت الحارس بفحصين: مفتاح محسوب + مفتاحان ميتان). */
    const mkEntry = (id, text, on) => {
      const b = mkNode('button', entryCss(on), null);
      b.id = id;
      b.type = 'button';
      if (on) b.appendChild(mkNode('span', null, '✓ '));
      b.appendChild(mkNode('span', null, text));
      return b;
    };
    const song = mkEntry('hl-ext-mode-song', t('menu.song'), MODE === 'song');
    const clip = mkEntry('hl-ext-mode-clip', t('menu.clip'), MODE === 'clip');
    menu.appendChild(song);
    menu.appendChild(clip);
    document.body.appendChild(menu);
    song.addEventListener('click', () => chooseMode('song'));
    clip.addEventListener('click', () => chooseMode('clip'));
    setTimeout(() => {
      if (!menu.isConnected) return;
      modeCloser = (e) => { if (!menu.contains(e.target)) closeModeMenu(); };
      document.addEventListener('click', modeCloser);
    }, 0);
  }
  /** يحفظ الوضع المختار ويبدأ به. و`BUSY` ⇒ لا بدء (الزرّ أثناء العمل للإلغاء). */
  function chooseMode(next) {
    MODE = next === 'song' ? 'song' : 'clip';
    paintModeBtn();
    closeModeMenu();
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ 'hl.popup.mode': MODE });
      }
    } catch (e) { /* بلا تخزين: يبقى الوضع للجلسة الحالية */ }
    // الوضع المختار صراحةً ⇒ **مسار الحفظ** (ناتج في مجلد المستخدم).
    if (!BUSY) void startFull('save');
  }
  function makeWatchBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_WATCH;
    btn.type = 'button';
    btn.className = 'ytp-button';
    btn.setAttribute('aria-label', 'HaramLite: watch filtered');
    btn.style.cssText = barBtnBase();
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (WATCH) stopWatch();
      else void startWatch();
    });
    // Options live on right-click: full reprocess (gap-skip is mandatory).
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleWatchMenu(btn);
    });
    return btn;
  }
  function setProc(state, pct) {
    PROC_VIEW = { state: state || 'idle', pct: pct || 0 };
    if (!procBtn) return;
    if (state === 'working') {
      procBtn.disabled = false;
      procBtn.style.opacity = '';
      procBtn.style.background = 'rgba(21,19,17,.94)';
      procBtn.style.borderColor = T.accent;
      procBtn.style.color = '#fff';
      procBtn.textContent = `${Math.round((pct || 0) * 100)}%`;
      procBtn.title = t('btn.proc.workingTitle');
    } else if (state === 'done') {
      procBtn.disabled = true;
      procBtn.style.opacity = '0.55';
      procBtn.style.background = 'rgba(21,19,17,.94)';
      procBtn.style.borderColor = T.accent;
      procBtn.style.color = T.text;
      procBtn.textContent = t('btn.proc.done');
      procBtn.title = t('btn.proc.doneTitle');
    } else {
      procBtn.disabled = false;
      procBtn.style.opacity = '';
      procBtn.style.background = 'rgba(21,19,17,.94)';
      procBtn.style.borderColor = T.accent;
      procBtn.style.color = T.text;
      procBtn.textContent = t('btn.proc.idle');
      procBtn.title = t('btn.proc.idleTitle');
    }
  }
  function setWatchBtn(state) {
    WATCH_VIEW = state || 'disabled';
    if (!watchBtn) return;
    if (state === 'ready') {
      watchBtn.disabled = false;
      watchBtn.style.opacity = '';
      watchBtn.style.background = 'rgba(21,19,17,.94)';
      watchBtn.style.borderColor = T.accent;
      watchBtn.style.color = '#ffb59d';
      watchBtn.textContent = t('btn.watch.ready');
      watchBtn.title = t('btn.watch.readyTitle');
    } else if (state === 'watching') {
      watchBtn.disabled = false;
      watchBtn.style.opacity = '';
      watchBtn.style.background = 'rgba(218,119,86,.6)';
      watchBtn.style.borderColor = T.accent;
      watchBtn.style.color = '#fff';
      watchBtn.textContent = t('btn.watch.stop');
      watchBtn.title = t('btn.watch.stopTitle');
    } else if (state === 'fetching') {
      watchBtn.disabled = true;
      watchBtn.style.opacity = '0.75';
      watchBtn.style.background = 'rgba(21,19,17,.94)';
      watchBtn.style.borderColor = T.accent;
      watchBtn.textContent = t('btn.watch.fetching');
      watchBtn.title = t('btn.watch.fetchingTitle');
    } else {
      watchBtn.disabled = true;
      watchBtn.style.opacity = '0.55';
      watchBtn.style.background = 'rgba(21,19,17,.94)';
      watchBtn.style.borderColor = '#5a544f';
      watchBtn.style.color = '#d8d2cc';
      watchBtn.textContent = t('btn.watch.ready');
      watchBtn.title = t('btn.watch.disabledTitle');
    }
  }
  function resetBar() {
    BUSY = false;
    LAST = null;
    setProc('idle');
    setWatchBtn('disabled');
  }

  /* ── watch secondary menu (right-click): options ───────────────── */
  function closeWatchMenu() {
    document.getElementById(MENU_ID)?.remove();
    if (menuCloser) {
      document.removeEventListener('click', menuCloser);
      menuCloser = null;
    }
  }
  function toggleWatchMenu(anchor) {
    if (document.getElementById(MENU_ID)) { closeWatchMenu(); return; }
    const r = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText =
      `position:fixed;bottom:${window.innerHeight - r.top + 8}px;right:${window.innerWidth - r.right}px;` +
      `min-width:210px;background:${T.panel};border:1px solid ${T.border};border-radius:10px;` +
      `box-shadow:0 10px 28px rgba(0,0,0,.55);padding:8px;z-index:2147483003;` +
      `font-family:Roboto,Arial,sans-serif;font-size:12px;direction:${RTL ? 'rtl' : 'ltr'};color:${T.text};`;
    // لا خيار للمستخدم: قفز الفجوات إجباريّ (قرار المالك «اجباري لكل مستخدم لا خيار
    // لتعديلها») — حُذف الصندوق، والقائمة فيها «معالجة كاملة» وحدها.
    // **ويُبنى بعقد DOM لا بـ`innerHTML`** — كان `innerHTML` هنا هو العطل نفسه
    // المقيس في قائمة الوضع (يوتيوب يفرض Trusted Types فيرمي عليه) ⇒ هذه القائمة
    // (النقر الأيمن) **لم تكن تُفتح إطلاقاً** على يوتيوب الحقيقي. المقيس حيّاً:
    // `TypeError: Failed to set the 'innerHTML' property on 'Element': This document
    // requires 'TrustedHTML' assignment.` — ولم يرها أيّ حارس jsdom (لا يفرض Trusted Types).
    const reprocess = mkNode('button', null, t('menu.reprocess'));
    reprocess.id = 'hl-ext-reprocess';
    reprocess.type = 'button';
    reprocess.style.cssText =
      `width:100%;padding:8px 6px;background:transparent;border:none;color:${T.sub};` +
      `font-size:12px;text-align:${RTL ? 'right' : 'left'};cursor:pointer;`;
    menu.appendChild(reprocess);
    document.body.appendChild(menu);
    reprocess.addEventListener('click', () => {
      closeWatchMenu();
      // نُبقي الإنهاء الصريح هنا: startFull() ينصرف فوراً إن كان BUSY، فلا تبقى مشاهدة قائمة.
      stopWatch(true);
      resetBar();
      // «معالجة كاملة» ⇒ **مسار الحفظ** (من طلب ناتجاً يجده في مجلده).
      void startFull('save');
    });
    setTimeout(() => {
      if (!menu.isConnected) return;
      menuCloser = (e) => { if (!menu.contains(e.target)) closeWatchMenu(); };
      document.addEventListener('click', menuCloser);
    }, 0);
  }

  /* ── request + poll (buttons only, no panels) ──────────────────── */
  let pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  /* **مدخلان للمعالجة بعقدين مختلفين** (قرار المالك 2026-09-23، بعد إفصاح
   * «لا كنس للنواتج · وناتج لكل ضغطة يتراكم»):
   *
   *   • `'watch'` — **زرّ المعالجة/المشاهدة** (‏`makeProcBtn`، وهو المدخل الذي
   *     يليه زرّ «شاهد بعد إزالة الموسيقى»): يرسل **علم مشاهدة صريحاً**
   *     `{type:'link', url, watch:true}` **بلا `mode`** ⇒ التطبيق يأخذ
   *     **المسار المؤقّت** (`bridge.rs:1067-1071`: `page_audio_dir()` — صوتي فقط،
   *     ولا شيء في مجلد المستخدم) ويقع على `s.watch_mode` لإعداد الوضع كما كان
   *     قبل 1.1.9. فلا تتراكم ملفات في `~/Videos/HaramLite` من زرّ المشاهدة.
   *   • `'save'` — **مدخلَا الوضع** («🎵 أغنية»/«🎬 مقطع») و**«معالجة كاملة»**:
   *     `mode:'song'|'clip'` **بلا علم مشاهدة** ⇒ مسار الحفظ الكامل (من يطلب
   *     ناتجاً يجده في مجلده).
   *
   * **والعلم منفصل عن `mode`**: لا يُعاد العقد القديم `mode:'watch'` (التطبيق
   * يقبل `watch:true` مع `mode` أو بلا — والشقّ الآخر في الرست يقرأ العلم).
   * و`watch` و`mode` **لا يجتمعان في طلب واحد من هذا الملف**: كل مدخل يرسل ما
   * يعنيه وحده، ويحرسه القياس الحيّ في الاتجاهين. */
  async function startFull(kind) {
    /* **قفل البدء** (نظير قفل الإلغاء، وبنفس صنف العطل): `BUSY` يُسند **بعد**
     * `await` (أسفل: `BUSY = true;` بعد ردّ الجرس)، فبين النقرة وردّ الجرس **لا
     * شيء يمنع طلباً ثانياً**. قِيس بجاسوس مستقلّ على `2b1d8c2`: نقرتان بفرق
     * **٥٫٤ مللي** ⇒ `link` ثم `link` (والنسخة القديمة أسوأ: ثلاث نقرات ⇒ ثلاثة
     * طلبات). والعلم يُسند **متزامنةً قبل الـ`await`** فيُغلق الباب **بلا ثابت
     * زمني** — بخلاف قفل الإلغاء الذي يحتاج نافذة زمنية لأنه يواجه إيماءة قد
     * تتكرّر بعد ثوانٍ. */
    if (BUSY || STARTING) return;
    // قفل الإلغاء: نقرة تابعة لإيماءة الإلغاء نفسها لا تُحيي مهمّة (التعليل أعلاه).
    if (Date.now() - CANCELLED_AT < CANCEL_LATCH_MS) {
      toast(t('cancel.done'));
      return;
    }
    STARTING = true;
    stopWatch(true);
    resetBar();
    // Pause the page at once — the goal is hearing no music. Failures leave
    // it paused with a message (YouTube's own play button resumes the
    // original); completion waits for the manual watch button.
    const pv = pageVideo();
    if (pv) { try { pv.pause(); } catch { /* gone */ } }
    SENT_URL = location.href;
    let r = null;
    try {
      // **العقدان** (التعليل في تعليق `startFull`): المشاهدة بعلمها بلا `mode`،
      // والحفظ باختيار الوضع بلا علم. و`mode` هو الحقل الذي يقرأه التطبيق
      // (`bridge.rs:826-832` — `job_mode_of`)، و`watch` علمه المستقلّ.
      const req = (kind === 'save')
        ? { type: 'link', url: location.href, mode: MODE }
        : { type: 'link', url: location.href, watch: true };
      r = await native(req);
    } catch (e) {
      toast('⚠ ' + errText(e, t('start.sendFailed')), 4000);
      return;
    } finally {
      STARTING = false;   // الطلب خرج من اليد: إمّا بدأت مهمّة (`BUSY`) أو فشل الإرسال
    }
    if (!r || !r.ok) {
      toast('✗ ' + errText(r, t('start.sendFailed')), 4000);
      return;
    }
    BUSY = true;
    setProc('working', 0);
    toast(t('start.received'));
    poll();
  }

  function doCancel() {
    CANCELLED_AT = Date.now();   // قفل الإلغاء — يمنع إحياء المهمّة بنقرة تابعة
    native({ type: 'cancel' }).catch(() => {});
    stopPoll();
    resetBar();
    toast(t('cancel.done'));
  }

  /** الزرّ في الشريط ليس زرّنا: نسخة أخرى من الإضافة تملكه ⇒ نُبلغ مرّة لكل صفحة. */
  function noteForeignBar() {
    FOREIGN_BAR = true;
    if (foreignTold) return;
    foreignTold = true;
    toast('⚠ ' + t('foreign.bar'), 6000);
  }

  function poll() {
    let sawRunning = false; // never show an OLD job's terminal state
    let fails = 0;
    pollTimer = setInterval(async () => {
      try {
        const r = await native({ type: 'status' });
        fails = 0; // healthy again
        const st = (r && r.state) || {};
        if (!BUSY) return; // foreign jobs never touch our buttons
        if (st.running) {
          sawRunning = true;
          setProc('working', (st.running && st.running.pct) || 0);
        } else if (st.last && (sawRunning || sameVideo(SENT_URL, st.last.url))) {
          // Fast jobs can finish between 1.5s polls unseen — the recorded
          // request URL (not the title-derived filename) proves ownership.
          stopPoll();
          stopPoll();
          BUSY = false;
          if (st.last.ok) {
            LAST = {
              seconds: st.last.seconds || 0,
              kept: Array.isArray(st.last.kept) ? st.last.kept : null,
            };
            setProc('done');
            setWatchBtn('ready');
            toast(t('poll.ok'));
          } else {
            resetBar();
            toast('✗ ' + errText(st.last, t('poll.failed')), 4000);
          }
        }
      } catch {
        // Give up after 8 consecutive failures instead of polling forever
        // against a dead bridge.
        fails += 1;
        if (fails >= 8) {
          stopPoll();
          resetBar();
          toast(t('poll.bridgeLost'), 4000);
        }
      }
    }, 1500);
  }

  /* ── filtered watching (no video jumping) ──────────────────────── */
  // The finished pipeline left page-audio on the desktop; the page fetches
  // it ONCE (bounded slices, size-verified — file DELIVERY, never live or
  // chunked streaming) into an <audio> element synced to the page <video>.
  // Rate pinned at 1x on both sides (+ player API guard). Muted gaps hold
  // the audio with edge-snapped resume; the drift backstop never forces a
  // sync while stopped. Restore is total.

  function hexToBytes(hex) {
    const n = hex.length / 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // Full-timeline seconds → cut-timeline seconds through kept ranges.
  function mapFullToCut(t, kept) {
    if (!kept || !kept.length) return t;
    let acc = 0;
    for (const pair of kept) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!(b > a)) continue;
      if (t <= a) break;
      acc += Math.min(t, b) - a;
    }
    return acc;
  }

  // True while the position sits inside a muted gap (kept-ranges known).
  function isGap(t, kept) {
    if (!kept || !kept.length) return false;
    for (const pair of kept) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!(b > a)) continue;
      if (t >= a && t < b) return false;
    }
    return true;
  }

  // Where the page video must jump: inside a kept range it stays put, inside a
  // removed stretch (music-only — the silence muting the music leaves behind)
  // it jumps to the next kept start, past the last range it stays. Jumping the
  // PICTURE is what makes the skip real: the filtered audio has the stretch
  // cut out of it, so mapping the audio alone just loops the seam.
  function skipVideoGaps(t, kept) {
    if (!kept || !kept.length) return t;
    for (const pair of kept) {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!(b > a)) continue;
      if (t >= a && t < b) return t;
      if (t < a) return a;
    }
    return t;
  }

// The boundary where the picture must jump next: the end of the kept range
// containing t, provided a removed stretch follows it. null when there is
// nothing to jump (inside a gap already, after the last range, or contiguous
// ranges). Pure, so scripts/check-extension-sync.cjs can extract and test it.
function nextGapStart(t, kept) {
  if (!kept || !kept.length) return null;
  for (let i = 0; i < kept.length; i++) {
    const a = Number(kept[i][0]);
    const b = Number(kept[i][1]);
    if (!(b > a)) continue;
    if (t < a) return a;                 // t sits in the stretch before this range
    if (t >= a && t < b) {
      const nxt = kept[i + 1];
      if (!nxt) return null;
      const na = Number(nxt[0]);
      return na > b ? b : null;          // a removed stretch follows this range
    }
  }
  return null;
}

// إحصاء فجوات الخريطة. أسقطه إصدار المراجعة فأُعيد: يقيس (أ) مجموع المحفوظ مقابل
// مدة الصوت المُسلَّم (فرضية الانزياح الثابت)، (ب) أصغر فجوة وأكبر فجوة وعدد ما
// دون نصف ثانية — والحدّ الفعلي من مسار Rust: min_silence 800ms − 2×keep 150ms.
// وأُضيف قياسان لضبط عتبات خطة «المشاهدة الأسلس» (نطاق 0.5–8s وحيث المقطع السابق
// طويل): hist مدرّج أطوال الفجوات، و before أدنى ووسيط طول المقطع المحفوظ السابق
// للفجوة — حساب خالص فوق kept، لا سلوك ولا مؤقّت ولا مستمع.
function gapStats(kept, jumpThreshold) {
  const out = {
    keptSum: 0, gaps: 0, smallGaps: 0, smallSeconds: 0, largestGap: 0, smallestGap: 0,
    // عدد الفجوات في خمس نطاقات بالثواني: 0.5–1 ثم 1–2 ثم 2–4 ثم 4–8 ثم 8 فأكثر.
    // وما دون نصف ثانية لا نطاق له هنا — يُقرأ من smallGaps/smallSeconds أعلاه.
    hist: [0, 0, 0, 0, 0],
    // طول المقطع المحفوظ السابق لكل فجوة: أدناه (min) ووسيطه (median) بالثواني.
    before: { min: 0, median: 0 },
  };
  if (!kept || !kept.length) return out;
  const befores = [];
  let prevEnd = 0;
  let prevLen = 0;                        // طول المقطع المحفوظ السابق، لا موضعه
  for (const pair of kept) {
    const a = Number(pair[0]);
    const b = Number(pair[1]);
    if (!(b > a)) continue;
    out.keptSum += b - a;
    if (a > prevEnd) {
      const g = a - prevEnd;
      out.gaps++;
      if (g > out.largestGap) out.largestGap = g;
      if (!out.smallestGap || g < out.smallestGap) out.smallestGap = g;
      if (g <= jumpThreshold) { out.smallGaps++; out.smallSeconds += g; }
      if (g >= 0.5) {
        if (g < 1) out.hist[0]++;
        else if (g < 2) out.hist[1]++;
        else if (g < 4) out.hist[2]++;
        else if (g < 8) out.hist[3]++;
        else out.hist[4]++;
      }
      // الفجوة الأولى — أي قبل أول مقطع محفوظ — لا مقطع سابق لها يُقاس، فتُهمَل
      // هنا وحدها: إدخال صفر مُصطنع كان سيسحب الأدنى والوسيط إلى الصفر.
      if (prevLen > 0) befores.push(prevLen);
    }
    prevEnd = b;
    prevLen = b - a;
  }
  if (befores.length) {
    befores.sort((x, y) => x - y);
    const mid = befores.length >> 1;
    out.before.min = befores[0];
    out.before.median = (befores.length % 2) ? befores[mid] : (befores[mid - 1] + befores[mid]) / 2;
  }
  return out;
}

// ── خطة «المشاهدة الأسلس» §٣-٤ (docs/EXT-SMOOTH-PLAN.md): دالة قرار نقية لكل فجوة ──
// الخطوة ٤: **موصولة الآن**. تُنادى من pacePlan — النداء الوحيد في هذا الملف — وpacePlan
// يناديه ماسح الفجوات `armGapJump` عند التسليح و`gapTick` عند الدخول داخل فجوة أصلاً،
// والقرار يُخزَّن في w.pace (`{ boundary, landing, rate }` للتسريع أو null للقطع) ويُنفَّذ
// في وضع التسريع أدناه. العتبات **لا تُقرأ** إلا من pacePlan.
// العتبات: `rate` = ٣× **قرار المالك رقم ٣** («*3 وقد تزيد لاحقا او تنقص حسب التجربه»)،
// والبقية **ابتدائية تُضبط بالتجربة** («نجرب الى ان نصل المناسب») — ولا يُقال عن رقم
// إنه «مقيس» قبل قياسه فعلاً على مقاطع حقيقية (§٣ سياسة الضبط).
const PACE_CFG = {
  cutBelow: 0.6,     // أقصر من ذلك: قفزة غير محسوسة، والتسريع لا يوفّر شيئاً يُذكر
  isolated: 20,      // ما قبلها وما بعدها بهذا الطول ⇒ قفزة واحدة نظيفة وتوفير أقصى
  maxSpeedGap: 6,    // تسريع 6s عند 3× = ثانيتان مشاهدة؛ الأطول منها ⇒ اقطع
  targetDwell: 1.0,  // زمن المشاهدة المستهدف لفجوة تُسرَّع (ثوان)
  rate: 3.0,         // سقف التسريع — قرار المالك (٣×) لا ابتدائي
  maxDwell: 1.5,     // شبكة أمان: إن تجاوز التسريع هذا الزمن ⇒ اقطع
};

// قرار فجوة واحدة من الخريطة وحدها: نقية، بلا حالة وبلا `video`/`audio`، وكل عتباتها
// من `cfg` وحدها (لا مرجع إلى ثوابت الجدول داخلها) ⇒ يستخرجها الحارس ويختبرها معزولة
// بلا متصفّح. تُنادى من pacePlan وحدها (الخطوة ٤)، والقرار يُخزَّن في w.pace.
// **عقد النداء كما في §٣**: يُمرَّر كائن الفجوة `{ gap, keptBefore, keptAfter }` ثم `cfg`.
// والتفكيك **داخل الجسم** لا في الوسائط، ليبقى أول قوس في نصّ الدالة قوسَ متنها
// فتستخرجها آلية الحارس القائمة (extractBlock) كما تُستخرج بقية الدوال النقية — بلا
// أي تغيير في الآلية (وسائط مفكَّكة تُخرج قوس الوسائط فيسقط بناء الحارس بـSyntaxError).
//   gap        : طول الفجوة بالثواني
//   keptBefore : طول المقطع المحفوظ الذي سبقها (منذ نهاية الفجوة السابقة)
//   keptAfter  : طول المقطع المحفوظ الذي يليها
function planGap(input, cfg) {
  const { gap, keptBefore, keptAfter } = input;
  // ١) فجوة قصيرة جداً: قفزة غير محسوسة، والتسريع لا يوفّر شيئاً يُذكر.
  if (gap < cfg.cutBelow) return { mode: 'cut', reason: 'tiny' };
  // ٢) فجوة معزولة: ما قبلها وما بعدها طويلان ⇒ قفزة واحدة نظيفة وتوفير أقصى.
  if (keptBefore >= cfg.isolated && keptAfter >= cfg.isolated) return { mode: 'cut', reason: 'isolated' };
  // ٣) فجوة طويلة: تسريعها يعني مشاهدة تسريع طويل ⇒ القطع أرحم.
  if (gap > cfg.maxSpeedGap) return { mode: 'cut', reason: 'long' };
  // ٤) وإلا: تسريع بمعدّل ثابت، مع سقف زمن مشاهدة.
  const rate = Math.min(cfg.rate, Math.max(1.2, gap / cfg.targetDwell));
  if (gap / rate > cfg.maxDwell) return { mode: 'cut', reason: 'dwell' };
  return { mode: 'speed', rate: +rate.toFixed(2) };
}

// طول المقطع المحفوظ الذي يحيط فجوة: الذي يسبقها (ينتهي عند بدايتها) والذي يليها
// (يبدأ عند نهايتها) — من الخريطة وحدها، نقية تماماً: بلا حالة وبلا `video`/`audio`
// وبلا أي مرجع خارجي ⇒ يستخرجها الحارس ويشغّلها في رمل معزول بلا متصفّح.
// والعقد **موضعيّ لا مفكَّك** (`(kept, gapStart, gapEnd)`) ليبقى أول قوس في نصّها قوسَ
// متنها فتستخرجها آلية extractBlock القائمة كما تُستخرج بقية الدوال النقية — وتفكيك
// الوسائط يجعل أول قوس قوسَ الوسائط فيسقط بناء الحارس كله بـSyntaxError (قيس ذلك).
//   kept     : الخريطة (أزواج [بداية, نهاية] بالثواني على الخط الزمني الكامل)
//   gapStart : بداية الفجوة (نهاية المقطع المحفوظ السابق لها)
//   gapEnd   : نهاية الفجوة (بداية المقطع المحفوظ التالي لها)
// تُرجع { before, after } بالثواني، وصفراً عن الجانب الذي لا مقطع له.
function keptStretchAround(kept, gapStart, gapEnd) {
  const out = { before: 0, after: 0 };
  if (!kept || !kept.length) return out;
  for (const pair of kept) {
    const a = Number(pair[0]);
    const b = Number(pair[1]);
    if (!(b > a)) continue;
    if (b <= gapStart) { out.before = b - a; continue; }
    if (a >= gapEnd) { out.after = b - a; break; }
  }
  return out;
}

  function pageVideo() {
    return document.querySelector('#movie_player video') || document.querySelector('video');
  }

  function pinPlayerRate() {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.setPlaybackRate === 'function') mp.setPlaybackRate(1);
    } catch { /* gone */ }
  }

  async function fetchPageAudio(onProg) {
    const parts = [];
    let offset = 0;
    let total = 0;
    for (;;) {
      const r = await native({ type: 'result_file', offset, len: 262144 });
      /* **ردّ فشل مسمّى** (`{ok:false, code, error}`) — يُرمى بخطأ يحمل رمزه ليترجمه
       * `errText`؛ وهذا هو العطل الميداني المقيس (بلاغ المالك 2026-09-23): التطبيق
       * يردّ `engine_error` («لا يوجد صوت صفحة مكتمل بعد» — `bridge.rs:433-440`) فكان
       * يُعرض «رد فارغ من التطبيق — أعد المحاولة»، وهو نصّ يصف **غياب** الردّ لا سببه،
       * ويُخفي الرمز الذي يحمله الردّ فعلاً. و`native()` لا يرمي هنا: `ok` التي يفحصها
       * هي `ok` **النقل** (`background.js` يمرّر حمولة المضيف كما هي في `resp`)،
       * فحمولة المضيف الفاشلة تصل مُحلَّلة لا مرميَّة. */
      if (r && r.ok === false) throw bridgeError(r);
      const f = r && r.file;
      // و`fetch.emptyReply` لا يبقى إلّا لغياب `file` فعلاً (لا ردّ)، وسِواه «ملف ناقص».
      if (!f) throw new Error(t('fetch.emptyReply'));
      if (typeof f.data !== 'string') throw new Error(t('fetch.partialFile'));
      total = f.total || 0;
      parts.push(f.data);
      offset = f.offset + f.data.length / 2;
      if (onProg) onProg(total > 0 ? offset / total : 0);
      if (f.done) break;
      if (total > 0 && offset >= total) break; // safety net
    }
    const flat = parts.join('');
    if (total > 0 && flat.length / 2 !== total) throw new Error(t('fetch.partialFile'));
    return URL.createObjectURL(new Blob([hexToBytes(flat)], { type: 'audio/mpeg' }));
  }

  function watchLine() {
    return LAST && LAST.seconds
      ? fill(t('watch.lineAgo'), { s: LAST.seconds.toFixed(1) })
      : t('watch.line');
  }

  async function startWatch() {
    if (WATCH) return;
    if (!LAST) {
      toast(t('watch.needMap'), 4000);
      return;
    }
    const video = pageVideo();
    if (!video) {
      toast(t('watch.noVideo'), 4000);
      return;
    }
    setWatchBtn('fetching');
    let url = null;
    try {
      url = await fetchPageAudio((p) => {
        if (watchBtn) watchBtn.textContent = fill(t('btn.watch.fetchingPct'), { pct: Math.round(p * 100) });
      });
    } catch (e) {
      setWatchBtn('ready');
      toast('✗ ' + errText(e, t('fetch.failed')), 4000);
      return;
    }
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    try {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(t('fetch.decodeFailed'))), 15000);
        audio.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(to); reject(new Error(t('fetch.unsupported'))); }, { once: true });
      });
    } catch (e) {
      URL.revokeObjectURL(url);
      setWatchBtn('ready');
      toast('✗ ' + errText(e), 4000);
      return;
    }
    // Duration gate: song outputs mirror silence cuts (mapped via kept);
    // without kept-ranges the timelines must coincide.
    const kept = LAST.kept;
    if ((!kept || !kept.length) && video.duration && audio.duration &&
        Math.abs(video.duration - audio.duration) > 2) {
      URL.revokeObjectURL(url);
      setWatchBtn('ready');
      toast(t('watch.mapMissing'), 4000);
      return;
    }
    const w = {
      audio, url, video,
      prevMuted: video.muted,
      prevRate: video.playbackRate || 1,
      handlers: [],
      drift: 0,
      gapTimer: 0,
      selfSeek: 0,   // طابع آخر قفزة صنعناها (لتمييزها عن قفزة المستخدم)
      held: false,
      stalled: false,   // المشغّل يتجمّد (إعادة تخزين بعد قفزتنا) والصوت يجب أن يُحتجَز
      pendingLead: null, // تقدّم ظهر مرة؛ لا يُصحَّح للخلف إلّا إن تكرّر
      loadLogged: false, // بوابة لمرّة واحدة: سطر قياس load لا يُصدَر إلّا مرة لكل جلسة مشاهدة
      // ── وضع التسريع (الخطوة ٤، §٤) ──────────────────────────────────────────
      // pace: قرار الفجوة — `{ boundary, landing, rate }` للتسريع أو null للقطع
      // (سلوك اليوم). paceTimer: مؤقّت الخروج من التسريع، في **حقل منفصل** عن gapTimer
      // لأن الماسح armGapJump يمسح gapTimer كل 250ms ⇒ مؤقّت خروج فيه كان يُمحى خلال
      // ربع ثانية فيبقى الفيديو مسرَّعاً بلا نهاية. selfRate: المعدّل الذي كتبناه نحن،
      // لتمييز حدث ratechange الذي ولّدته كتابتنا عن إعادة الموقع للمعدّل (سقوط إلى
      // القطع). وprevRate **لا يُكتب فيه معدّل التسريع أبداً**: يُلتقط عند بدء المراقبة
      // وتستعيده stopWatch.
      pace: null, paceTimer: 0, selfRate: null,
    };
    const SELF_SEEK_MS = 1200; // كان 600؛ مشغّل ثقيل قد يتأخّر play أكثر من ذلك
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); w.handlers.push([el, ev, fn]); };
    const audioPos = () => {
      const t = mapFullToCut(video.currentTime || 0, kept);
      return Math.min(Math.max(t, 0), Math.max(audio.duration - 0.05, 0));
    };
    const slog = (() => { try { return localStorage.getItem('hl.synclog') === '1'; } catch { return false; } })();
    const trace = (site, extra) => {
      if (!slog) return;
      const row = {
        t: Date.now() % 60000, site,
        v: +((video.currentTime || 0).toFixed(3)),
        a: +(audio.currentTime.toFixed(3)),
        want: +(audioPos().toFixed(3)),
        gap: isGap(video.currentTime || 0, kept),
        held: w.held,
        selfMs: Date.now() - (w.selfSeek || 0),
        drift: extra || '',
      };
      // بوابة لمرّة واحدة (إصلاح عود لا نهائي دخل في 89c78e1): نصّ هذا السطر كان
      // موضوعاً في جسم trace بلا بوابة، فكان trace ينادي نفسه أبداً حتى
      // RangeError ولا يصل صفّ إلى window.__hlSync. العلم في كائن الحالة w فهو
      // يُصفَّر مع كل جلسة مشاهدة جديدة، **ويُضبط قبل النداء** ليكون النداء واحداً
      // بالضبط حتى لو أطلق مسارٌ ما نداءً متداخلاً.
      // وشرط الصلاحية audio.duration > 0: بلا قفل العلم على قياس **صالِح** كان
      // أول نداء (وقد يسبق جهوزية المدة) يُصدِر audioDur=0 وdiff=keptSum، فيُقفل
      // العلم على رقم مضلِّل ويضيع القياس الميداني أبداً. الشرط هنا على مدة الصوت
      // وحدها لأن diff = keptSum − audioDur هو الرقم الذي يحسم مطابقة الخريطة؛
      // vDur قد يبقى 0 ولا يضرّ (يُقاس 0 في السطر نفسه أدناه).
      if (slog && !w.loadLogged && isFinite(audio.duration) && audio.duration > 0) {
        w.loadLogged = true;
        // سطر قياس واحد: يحسم «هل الخريطة تطابق الملف المُسلَّم» و«هل توجد فجوة أصغر
        // من عتبة القفز» (وهو ما أسقط الفرضية الخامسة: الحدّ الفعلي 500ms).
        const st = gapStats(kept, 0.5);
        const ad = isFinite(audio.duration) ? audio.duration : 0;
        const vd = isFinite(video.duration) ? video.duration : 0;
        // والحقول المضافة: hist مدرّج الفجوات (خمسة نطاقات) و keptBefore أدنى/وسيط
        // طول المقطع المحفوظ السابق للفجوة — لضبط عتبات قرار التسريع/القطع بالتجربة.
        trace('load', `keptSum=${st.keptSum.toFixed(3)} audioDur=${ad.toFixed(3)} vDur=${vd.toFixed(3)} diff=${(st.keptSum - ad).toFixed(3)} gaps=${st.gaps} smallestGap=${st.smallestGap.toFixed(3)} belowHalf=${st.smallGaps} belowHalfSeconds=${st.smallSeconds.toFixed(3)} largestGap=${st.largestGap.toFixed(3)} hist=[${st.hist.join(',')}] keptBefore={min:${st.before.min.toFixed(3)},med:${st.before.median.toFixed(3)}}`);
      }
      (window.__hlSync = window.__hlSync || []).push(row);
      if (window.__hlSync.length > 4000) window.__hlSync.shift();
      try { console.log('HL-SYNC', JSON.stringify(row)); } catch { /* gone */ }
    };
    // لا سحب للخلف على صوت يعمل: الخريطة مسطّحة داخل الفجوة، فأي إرساء من
    // video.currentTime عند الحدّ يعيد كلمات سُمعت. قفزة المستخدم وحدها مسموحة.
    const setAudioTime = (site, want, allowBack) => {
      const cur = audio.currentTime;
      const delta = cur - want;
      trace(site, `d=${delta.toFixed(3)}`);
      if (!allowBack && !audio.paused && delta > 0.05) {
        trace(site + '-skip', 'no-rewind');
        return;
      }
      if (!(Math.abs(delta) > 0.05)) return;
      try { audio.currentTime = want; } catch { /* gone */ }
    };
    // إعادة إرساء الصوت على موضع القفزة نفسها.
    // السبب (عطل ميداني موصوف): الصورة تقفز وحدها بـcurrentTime، والصوت عنصر
    // آخر يواصل مكانه، فلا يُصحَّح إلا بتسامح 0.35s كل ثانية ⇒ يُسمع ذيل المقطع
    // المحذوف (كلمة مكررة) ثم يعود فجأة. الهدف يُحسب من الهدف المقصود لا من
    // video.currentTime، لأن قراءته بعد الإسناد غير موثوقة (القفز غير متزامن).
    const reanchorAudio = (fullT) => {
      const want = Math.min(Math.max(mapFullToCut(fullT, kept), 0), Math.max(audio.duration - 0.05, 0));
      if (!(Math.abs(audio.currentTime - want) > 0.05)) return;
      let done = false;
      const unmute = () => {
        if (done) return;
        done = true;
        try { audio.muted = false; } catch { /* gone */ }
        audio.removeEventListener('seeked', unmute);
      };
      // كتم لحظي يعبر القفزة: يقطع الذيل المسموع بين الإسناد ووصول seeked
      try { audio.muted = true; } catch { /* gone */ }
      try { audio.currentTime = want; } catch { /* gone */ }
      audio.addEventListener('seeked', unmute);
      setTimeout(unmute, 120);   // شبكة أمان إن لم يصل seeked
      trace('reanchor', `full=${fullT.toFixed(3)}`);
    };
    const kickAudio = () => {
      // play حول قفزتنا: يوتيوب يطلق play/playing بعد الإسناد. الخريطة مسطّحة
      // عند الحدّ ⇒ audioPos() = الدرزة، والصوت قد تقدّم ⇒ سحب للخلف = تكرار.
      // لا نُرسي إلا صوتاً متوقفاً وخارج نافذة selfSeek (بدء المشاهدة / قفزة مستخدم).
      // و**التسريع يملك الصوت**: محتجَز بقصد حتى نهاية الفجوة، فإرساؤه أو استئنافه هنا
      // (و`play` في آخر هذه الدالة غير مشروط) يُسمعه مقدَّماً على صورة مسرَّعة ثم يعيده
      // خروج التسريع إلى الدرزة ⇒ كلمة مكررة. والشرط **فعّال** (w.paceTimer) لا مجرّد
      // قرار مُسلَّح: القرار يُسلَّح حتى 1.5s قبل الحدّ والصوت فيها يعمل طبيعياً.
      if (w.pace && w.paceTimer) { trace('kick-skip', 'pace'); return; }
      if (Date.now() - (w.selfSeek || 0) < SELF_SEEK_MS) {
        trace('kick-skip', 'selfSeek');
      } else if (audio.paused) {
        setAudioTime('kick', audioPos(), false);
      } else {
        trace('kick-skip', 'playing');
      }
      audio.play().then(() => {
        if (WATCH) toast(watchLine());
      }).catch(() => {
        // No user activation (timer-started autoplay): the next press of
        // play IS a gesture and retries through the play-handler below.
        if (WATCH) toast(t('watch.playAudio'), 4000);
      });
    };
    /* ── وضع التسريع — الخطوة ٤ (docs/EXT-SMOOTH-PLAN.md §٤) ─────────────────────
     * صوت المخرَج **لا يحتوي الفجوة** (مقطوع في التطبيق) وmapFullToCut **مسطّحة داخل
     * الفجوة** ⇒ «التسريع» = احتضار الصوت (audio.pause + w.held) + رفع معدّل الصورة
     * إلى معدّل القرار، ثم إعادتهما عند نهاية الفجوة. **لا seek إطلاقاً** ⇒ لا إعادة
     * تخزين ولا وقفة صورة (وهو عطل القطع الذي نُعالجه). ولا يُغيَّر audio.playbackRate
     * عن 1، ولا يُكتب audio.currentTime إلا من البوابتين القائمتين (setAudioTime ·
     * reanchorAudio). وهذه الدوال معرَّفة **قبل** المستمعين الذين ينادونها.
     */
    // الخروج: إعادة المعدّل (**من w.prevRate — ولا يُكتب فيه معدّل التسريع أبداً**) ·
    // رفع الاحتجاز · إعادة إرساء الصوت على الموضع المخطَّط بـallowBack=true (الصوت قد
    // يكون متقدّماً بجزء من الثانية ويلزم تصحيحه للخلف) · استئناف التشغيل · تصفير الحالة.
    const paceExit = (why) => {
      if (!w.pace) return;
      if (w.paceTimer) { clearTimeout(w.paceTimer); w.paceTimer = 0; }
      w.pace = null;
      w.selfRate = null;
      try { video.playbackRate = w.prevRate || 1; } catch { /* gone */ }
      w.held = false;
      setAudioTime('pace-release', audioPos(), true);
      // الصورة متوقّفة أو متجمّدة (مسار pause أو تجمّد مشغّل): **لا استئناف**. في
      // الوقفة: `play` ثم `pause` فوراً يُرفض وعده (AbortError) فيُضبط w.held احتجازاً
      // كاذباً بلا وقفة حقيقية. وفي التجمّد `video.paused` كاذب والعدّاد مجمّد، فالاستئناف
      // يُسمع الصوت على صورة واقفة ⇒ تقدّم يتراكم ثم يُسحبه stallRelease للخلف ⇒ كلمة
      // مكررة (وهو ما وُجد احتجاز التجمّد لمنعه). والإرساء أعلاه غير مسموع (الصوت
      // متوقّف)، والاستئناف يتولّاه stallRelease عند `playing` أو kickAudio عند `play`.
      if (video.paused || w.stalled) {
        trace('pace-exit', `${why || 'end'} ${video.paused ? 'paused' : 'stalled'}`);
        return;
      }
      audio.play().catch(() => { w.held = true; });
      trace('pace-exit', why || 'end');
    };
    // الدخول (عند الحدّ أو داخل فجوة أصلاً): احتضار الصوت + رفع المعدّل + مؤقّت خروج
    // عند نهاية الفجوة. المؤقّت في **w.paceTimer** لا في w.gapTimer: الماسح armGapJump
    // يمسح w.gapTimer كل 250ms ⇒ مؤقّت خروج فيه كان يُمحى خلال ربع ثانية ويبقى الفيديو
    // مسرَّعاً بلا نهاية. وw.selfRate يُكتب **قبل** كتابة المعدّل ليكون حدث ratechange
    // الذي ولّدته كتابتنا معروفاً لنا.
    const paceEnter = (boundary, landing, rate) => {
      w.pace = { boundary, landing, rate };
      w.held = true;
      try { audio.pause(); } catch { /* gone */ }
      w.selfRate = rate;
      try { video.playbackRate = rate; } catch { /* gone */ }
      const left = Math.max(landing - (video.currentTime || 0), 0);
      w.paceTimer = setTimeout(() => paceExit('timer'), (left / rate) * 1000);
      trace('pace-enter', `rate=${rate} left=${left.toFixed(3)}`);
    };
    // سقوط آمن: المشغّل رفض معدّلنا (ratechange من الموقع) ⇒ نُسقط قرار التسريع لهذه
    // الفجوة ونعود إلى القطع. لا إرساء ولا استئناف هنا: القفزة في gapTick هي التي
    // تُرسي الصوت (فرع w.held داخلها) وتستأنفه ⇒ لا تسريع معلَّق ولا صوت محتجَز بلا خروج.
    const paceReject = () => {
      const r = w.pace ? w.pace.rate : 0;
      if (w.paceTimer) { clearTimeout(w.paceTimer); w.paceTimer = 0; }
      w.pace = null;
      w.selfRate = null;
      trace('pace-reject', `rate=${r} site=${(video.playbackRate || 0).toFixed(2)}`);
    };
    // قرار الفجوة: يُحسب **مرة واحدة** نقياً (planGap + keptStretchAround) ويُخزَّن في
    // w.pace للتسريع أو null للقطع، ويُطبع في الأثر بـreason فيُعرف أيّ قاعدة قرّرت.
    // والصفّ يُصدَر **عند تغيّر القرار فقط**: الماسح يعيد التسليح كل 250ms في آخر 1500ms
    // قبل الحدّ، فبلا هذا الشرط يتكرّر الصفّ نفسه ~٦ مرات لكل فجوة ويزحم حلقة الأثر
    // (سعتها 4000). والمفتاح محليّ لا حقل حالة: لا يمسّ w.
    let pacePlanKey = '';
    const pacePlan = (gapStart, gapEnd) => {
      const st = keptStretchAround(kept, gapStart, gapEnd);
      const plan = planGap({ gap: gapEnd - gapStart, keptBefore: st.before, keptAfter: st.after }, PACE_CFG);
      w.pace = plan.mode === 'speed' ? { boundary: gapStart, landing: gapEnd, rate: plan.rate } : null;
      const key = `${plan.mode}|${plan.rate || 0}|${plan.reason || '-'}|${gapStart.toFixed(3)}`;
      if (key !== pacePlanKey) {
        pacePlanKey = key;
        trace('pace-plan', `mode=${plan.mode} rate=${plan.rate || 0} gap=${(gapEnd - gapStart).toFixed(3)} keptBefore=${st.before.toFixed(3)} reason=${plan.reason || '-'}`);
      }
      return w.pace;
    };
    on(video, 'play', () => {
      // The page player fights mute — pin it on every play.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      trace('play', audio.paused ? 'paused' : 'playing');
      kickAudio();
      gapTick();   // فجوة أمامية (فيديو يبدأ بموسيقى): اقلبها فوراً لا بعد 250ms
    });
    // الوقفة تُخرج من التسريع أيضاً: لا تسريع بلا تشغيل. والخروج يعيد المعدّل ويرفع
    // الاحتجاز، ثم يُوقف الصوت كالمعتاد.
    on(video, 'pause', () => {
      trace('pause');
      paceExit('pause');
      audio.pause();
    });
    // وقفة المشغّل ليست إيقافاً: بعد قفزتنا يُعيد يوتيوب التخزين فيتجمّد عدّاد
    // الصورة بينما الصوت يواصل ⇒ ينشأ **تقدّم** لا يُصحّحه الانحراف الأمامي أبداً
    // (بلاغ المالك 2026-09-15: «الفيديو قد يقف قليلاً بعد التخطي» + تقدّم قوي).
    // فتُحتجَز هنا كما في فجوة الصمت، وتُرسى عند الاستئناف — وهو الموضع الوحيد
    // الذي يُسمح فيه بالسحب للخلف بلا قفزة مستخدم، ولهذا يُوسَم في الأثر.
    const stallHold = () => {
      if (!WATCH || video.paused || w.stalled) return;
      w.stalled = true;
      try { audio.pause(); } catch { /* gone */ }
      trace('stall', 'hold');
    };
    const stallRelease = () => {
      if (!WATCH || !w.stalled) return;
      w.stalled = false;
      // تسريع قائم: الصوت محتجَز **بقصد** حتى نهاية الفجوة، فإطلاقه هنا يُسمعه مقدَّماً
      // على صورة مسرَّعة ثم يعيده خروج التسريع إلى الدرزة ⇒ كلمة مكررة. الخروج هو الذي
      // يستأنفه (وشبكة الأمان في الماسح تكفل ألّا يبقى محتجَزاً).
      if (w.pace && w.paceTimer) return;
      setAudioTime('stall-release', audioPos(), true);
      audio.play().catch(() => { w.stalled = true; });
      trace('stall', 'release');
    };
    on(video, 'waiting', stallHold);
    on(video, 'stalled', stallHold);
    on(video, 'playing', stallRelease);
    on(video, 'seeking', () => {
      // قفزة صنعناها نحن هي إسنادٌ لـcurrentTime، والصفحة تُطلق seeking لها
      // والموضع القديم لا يزال داخل الفجوة. معالجتها كقفزة مستخدم كان يضبط
      // w.held ويوقف الصوت، ثم يُرسيه المؤقّت فيُعاد سماع ما سُمِع (تكرار حتى
      // ثلاث مرات مع الفجوات المتقاربة — بلاغ المالك 2026-09-15). فتُتجاهل هنا.
      if (Date.now() - (w.selfSeek || 0) < SELF_SEEK_MS) return;
      // قفزة المستخدم: طلب موضعاً بنفسه ⇒ لا تسريع بعده (والخروج يعيد المعدّل ويرفع
      // الاحتجاز ويرسي الصوت على الموضع المطلوب، ثم يكمل المعالج القائم عمله).
      paceExit('seeking');
      const now = video.currentTime || 0;
      if (isGap(now, kept)) {
        w.held = true;
        try { audio.pause(); } catch { /* gone */ }
      } else {
        w.held = false;
        const want = audioPos();
        // Same tolerance as the drift backstop, and for the same reason: our
        // own gap jump moves the picture over time the cut audio does not
        // contain, so the mapped position barely moves — re-anchoring there
        // would rewind ~0.2s of sound at every gap edge. Only a real seek
        // lands far enough away to need correcting.
        if (Math.abs(audio.currentTime - want) > 0.35) {
          // قفزة مستخدم حقيقية فقط. السماح بالرجوع لأن المستخدم طلب موضعاً أقدم.
          setAudioTime('seeking', want, true);
        }
      }
    });
    on(video, 'ratechange', () => {
      // معدّلنا نحن (وضع التسريع): هذا حدث ratechange ولّدته كتابتنا ⇒ يُتجاهل، وإلا
      // فرضنا 1× في منتصف الفجوة فأبطلنا التسريع الذي قرّرناه (بتسامح 0.05 كما في §٤).
      if (w.selfRate && Math.abs(video.playbackRate - w.selfRate) < 0.05) { trace('rate', 'ours'); return; }
      // الموقع أعاد المعدّل ⇒ التسريع غير مدعوم هنا: **اسقط إلى القطع لهذه الفجوة**
      // (سقوط آمن: لا تسريع معلَّق ولا صوت محتجَز — القفزة في gapTick تُرسي الصوت).
      if (w.pace) {
        const b = w.pace.boundary;
        const l = w.pace.landing;
        trace('rate', 'rejected→cut');
        paceReject();
        gapTick(b, l);
      }
      // Guard both sides at 1.0 for the whole watch (anti-2x).
      if (video.playbackRate !== 1) { try { video.playbackRate = 1; } catch { /* gone */ } }
      pinPlayerRate();
      audio.playbackRate = 1;
    });
    on(video, 'volumechange', () => {
      // Volume gestures unmute the page player — pin it, then mirror.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      audio.volume = video.volume;
    });
    on(audio, 'ended', () => {
      // Filtered audio over: stop the picture too, or the tail would run on
      // and restore into unmuted original audio past the map.
      try { video.pause(); } catch { /* gone */ }
      stopWatch();
    });
    on(video, 'ended', () => { stopWatch(); });
    // Declared mute + 1x clamp on both sides (+ player API guard).
    video.muted = true;
    try { video.playbackRate = 1; } catch { /* gone */ }
    pinPlayerRate();
    audio.playbackRate = 1;
    audio.volume = video.volume;
    WATCH = w;
    w.drift = setInterval(() => {
      if (!WATCH) return;
      // The page player fights mute — pin it every tick.
      if (video.muted === false) { try { video.muted = true; } catch { /* gone */ } }
      // التخطي إجباريّ (لا خيار للمستخدم): لا فرع «احتجاز عند الدرزة» — كان مخصّصاً
      // لحالة إطفاء الخيار. وw.held يبقى حيّاً: قفزة المستخدم داخل فجوة تُحتجزه
      // (معالج seeking)، فيُرسى هنا عند الاستئناف.
      // **وفي وضع التسريع لا تصحيح ولا إطلاق احتجاز إطلاقاً**: الصوت محتجَز بقصد
      // وصورة تسرَّع؛ ففرع held-release أدناه كان يُعيد تشغيل الصوت بعد ثانية ⇒ صوت
      // يعمل مع صورة مسرَّعة = تقدّم صوت — وهو العطل الذي نُعالجه لا نُعيده.
      if (w.pace) return;
      if (w.held && !video.paused) {
        w.held = false;
        setAudioTime('held-release', audioPos(), true);
        audio.play().catch(() => { w.held = true; });
      }
      // No forced sync while stopped (paused or held) — that fight is what
      // looped the seams. Correct only a freely playing audio.
      // Asymmetric: catch up FORWARD if audio lags; never rewind a lead —
      // a 0.35s skip is inaudible, a 0.35s rewind is a repeated word.
      if (audio.paused) return;
      if (Date.now() - (w.selfSeek || 0) < SELF_SEEK_MS) return;
      if (isGap(video.currentTime || 0, kept)) return;
      if (w.stalled) return;   // الصورة متجمّدة: الاحتجاز يعالجها لا النبضة
      const expect = audioPos();
      // أمامي افتراضاً: السحب للخلف يُسمع كلمة مكررة. لكن تقدّماً **يستمر** هو
      // انزياح حقيقي (وقفة لم نرها، أو فرق ساعة بين العنصرين)، والقاعدة الأمامية
      // وحدها تتركه ينمو بلا حدّ — ولهذا يُسمح بالسحب للخلف فقط إذا تكرّر التقدّم
      // بنفس الاتجاه والمقدار في نبضتين متتاليتين (فارق ~ثانية).
      const lead = audio.currentTime - expect;
      if (lead > 0.35) {
        const confirmed = w.pendingLead && Math.abs(lead - w.pendingLead) < 0.35;
        if (confirmed) {
          w.pendingLead = null;
          trace('drift', `confirmed-backward d=${lead.toFixed(3)}`);
          setAudioTime('drift-confirmed', expect, true);
        } else {
          w.pendingLead = lead;
          trace('drift', `pending-lead d=${lead.toFixed(3)}`);
        }
      } else if (lead < -0.35) {
        w.pendingLead = null;
        setAudioTime('drift', expect, false);   // إلحاق أمامي — لا يُسمع
      } else {
        w.pendingLead = null;
      }
    }, 1000);
    // The skip itself (mandatory — no user option): the page video jumps over
    // every removed stretch while the filtered audio — which has those stretches
    // cut out of it — keeps playing untouched, so picture and sound stay in step.
    // 250ms cadence and >0.15s jumps, so a play/pause toggle or a pause mid
    // gap never triggers a stray seek, and the map has already dropped every
    // sliver under 100ms.
    // وفي وضع التسريع لا قفز هنا إطلاقاً: القفز داخل الفجوة يُبطل التسريع (وهو الذي
    // اختاره القرار بدل القطع)، والخروج يتولّاه paceTimer وشبكة الأمان في الماسح.
    const gapTick = (boundary, landing) => {
      if (!WATCH || video.paused) return;
      if (w.pace && w.paceTimer) return;      // تسريع فعّال: لا قفز (الماسح ينادي كل 250ms)
      const now = video.currentTime || 0;
      let target = null;
      let pace = null;                        // قرار هذه الفجوة: تسريع أو null (قطع)
      if (typeof boundary === 'number' && typeof landing === 'number' && now >= boundary - 0.12) {
        if (now < boundary) {
          // أطلقت بضعة أجزاء من الثانية قبل الحدّ (تقريب المؤقّت). نُعيد التسليح
          // للباقي بدل القفز الآن (القفز المبكر يقصّ محتوى محفوظاً) وبدل لا شيء
          // (وهو ما كان يُرجع العمل للماسح 250ms فيتقدّم الصوت على الصورة عند كل
          // فجوة ولا يُصحَّح إلا بعد تراكم 0.35s — بلاغ المالك 2026-09-15).
          if (w.gapTimer) clearTimeout(w.gapTimer);
          w.gapTimer = setTimeout(() => { w.gapTimer = 0; gapTick(boundary, landing); }, (boundary - now) * 1000);
          return;
        }
        // وصلنا الحدّ: نقطة الهبوط محسوبة مسبقاً. والقرار مُتّخذ عند التسليح لهذه
        // الفجوة نفسها (تطابق الحدّ يمنع قراراً عالقاً من فجوة سابقة)، وما بعد نقطة
        // الهبوط لا يُلمس (تأخّر المؤقّت كثيراً ⇒ لا قفزة إلى الخلف على فجوة انتهت).
        if (now < landing) {
          target = landing;
          pace = (w.pace && Math.abs(w.pace.boundary - boundary) < 0.001) ? w.pace : null;
        }
      } else if (isGap(now, kept)) {
        // دخلنا فجوة بلا تسليح (تشغيل أو قفزة مستخدم داخل فجوة): القرار يُحسب الآن
        // للفجوة الحالية — بدايتها الموضع الحالي فالمقيس هو ما تبقّى منها إلى نهايتها.
        const land = skipVideoGaps(now + 1e-6, kept);
        if (land > now) { target = land; pace = pacePlan(now, land); }
      }
      if (pace) { paceEnter(pace.boundary, pace.landing, pace.rate); return; }
      if (target === null) target = skipVideoGaps(now, kept);
      if (!(Math.abs(target - now) > 0.15)) return;
      w.selfSeek = Date.now();    // قفزتنا: تُعلَن كي لا يعدّها معالج seeking قفزة مستخدم
      trace('gapTick', `→${target.toFixed(3)}`);
      try { video.currentTime = target; } catch { /* gone */ }
      if (w.held) {
        // A seek landed inside a removed stretch and the jump just left it: the
        // audio was paused at the seam, so it must be re-seated — and the hold
        // is released here instead of waiting up to a second for the scanner.
        reanchorAudio(target);
        w.held = false;
        audio.play().catch(() => { w.held = true; });
      }
      // Otherwise the audio is deliberately NOT touched. mapFullToCut is FLAT
      // across a removed stretch, so continuously playing audio is already in
      // step with the picture after the jump; re-seating it would drag it
      // BACKWARDS over sound that was legitimately heard. That drag is the
      // repeated-word artefact reported 2026-09-15 (silence 0..12s: the first
      // ~0.2s of the next segment was heard twice, then corrected). Only the
      // held case — a real seek into a gap — needs a re-seat.
    };
    // The 250ms scanner below only DISCOVERS a removed stretch, up to a quarter
    // second after the picture entered it — and in that window the filtered
    // audio plays on while the picture still shows silence, so the sound leads
    // the picture by that much at every seam. This arms a one-shot timer for
    // the exact boundary (with the landing point precomputed, since reading
    // currentTime right after a jump is not trustworthy); the scanner stays as
    // the safety net and re-arms it on every tick, and a play that starts inside
    // a gap jumps immediately.
    const armGapJump = () => {
      // تسريع فعّال: شبكة الأمان وحدها — إن لم يبقَ الموضع داخل فجوة (فجوة بلا نهاية
      // أو خريطة شاذّة) أو بلغنا نقطة الهبوط ⇒ اخرج فوراً، وإلا فلا قفز ولا إعادة
      // تسليح. والفحص **قبل** مسح w.gapTimer: لو مسحناه هنا لمحونا مؤقّت الحدّ الذي
      // سيُدخل التسريع قبل أن يُطلَق فيبقى الفيديو بلا تسريع أبداً.
      if (w.pace && w.paceTimer) {
        const at = video.currentTime || 0;
        if (!isGap(at, kept) || at >= w.pace.landing) paceExit('net');
        return;
      }
      if (w.gapTimer) { clearTimeout(w.gapTimer); w.gapTimer = 0; }
      if (!WATCH || video.paused) return;
      const now = video.currentTime || 0;
      if (isGap(now, kept)) { gapTick(); return; }
      const boundary = nextGapStart(now, kept);
      if (boundary === null) return;
      const dt = (boundary - now) * 1000;
      if (!(dt >= 0) || dt > 1500) return;   // only the imminent boundary
      const landing = skipVideoGaps(boundary + 1e-6, kept);
      // قرار الفجوة يُحسب **مرة واحدة عند التسليح** ويُخزَّن في w.pace (null ⇒ قطع
      // كاليوم)، ثم ينفّذه gapTick عند بلوغ الحدّ.
      pacePlan(boundary, landing);
      w.gapTimer = setTimeout(() => { w.gapTimer = 0; gapTick(boundary, landing); }, dt);
    };
    w.gap = setInterval(armGapJump, 250);
    if (slog) w.tracePulse = setInterval(() => { if (WATCH) trace('tick'); }, 40);
    setWatchBtn('watching');
    toast(watchLine());
    // The video was paused at request time — resume both together.
    try { await video.play(); } catch { toast(t('watch.playVideo'), 4000); }
    kickAudio();
  }

  function stopWatch(quiet) {
    const w = WATCH;
    WATCH = null;
    if (!w) return;
    if (w.drift) clearInterval(w.drift);
    if (w.gap) clearInterval(w.gap);
    if (w.tracePulse) clearInterval(w.tracePulse);
    if (w.gapTimer) clearTimeout(w.gapTimer);
    // مؤقّت الخروج من التسريع في حقل منفصل، ويُصفَّر هنا أيضاً مع مسح قراره: الإيقاف
    // لا يترك مؤقّتاً حيّاً يُعيد معدّلاً بعد أن عاد الصوت الأصلي. وإعادة المعدّل إلى
    // w.prevRate قائمة أصلاً في سطر إعادة معدّل الصورة أدناه فلا تُكرَّر.
    if (w.paceTimer) clearTimeout(w.paceTimer);
    w.paceTimer = 0;
    w.pace = null;
    w.selfRate = null;
    for (const [el, ev, fn] of w.handlers) {
      try { el.removeEventListener(ev, fn); } catch { /* gone */ }
    }
    try { w.audio.pause(); } catch { /* gone */ }
    try { w.video.muted = w.prevMuted; } catch { /* gone */ }
    try { w.video.playbackRate = w.prevRate; } catch { /* gone */ }
    pinPlayerRateRestore(w.prevRate);
    try { URL.revokeObjectURL(w.url); } catch { /* gone */ }
    if (LAST) setWatchBtn('ready');
    else setWatchBtn('disabled');
    if (!quiet) toast(t('watch.stopped'));
  }

  function pinPlayerRateRestore(rate) {
    try {
      const mp = document.getElementById('movie_player');
      if (mp && typeof mp.setPlaybackRate === 'function') mp.setPlaybackRate(rate || 1);
    } catch { /* gone */ }
  }

  /* ── injection (SPA-safe, per-video reset) ─────────────────────── */
  let currentVideoUrl = null;

  // Status check decoupled from injection: SPA navigation often KEEPS the
  // bar buttons alive, so tryInject's early-return used to skip the check
  // forever (watch stayed disabled on every navigated video). This runs on
  // every distinct URL whether the buttons persisted or were just created.
  function checkStatusForCurrentVideo() {
    setProc('idle');
    setWatchBtn('disabled');
    native({ type: 'status' }).then((r) => {
      const st = r && r.state;
      const last = st && st.last;
      if (last && last.ok && sameVideo(location.href, last.url)) {
        LAST = {
          seconds: last.seconds || 0,
          kept: Array.isArray(last.kept) ? last.kept : null,
        };
        setProc('done');
        setWatchBtn('ready');
        return;
      }
      // A download-phase job of THIS video still running → track it (the
      // running name is the request URL there; later phases rename it).
      const run = st && st.running;
      if (run && typeof run.name === 'string' && sameVideo(location.href, run.name) && !BUSY) {
        BUSY = true;
        setProc('working', run.pct || 0);
        poll();
      }
    }).catch(() => {});
  }

  /* ── موضعا الحقن — **مقيسان حيّاً** (كروم 153.0.8010.53، تبويبان حقيقيان) ────
   * • `www.youtube.com`: `.ytp-right-controls` (المحدِّد التاريخي، قائم).
   * • `music.youtube.com`: `.ytp-right-controls` **غير موجود إطلاقاً** —
   *   `document.querySelectorAll('.ytp-right-controls').length === 0` على صفحة
   *   `music.youtube.com/watch?v=AJOOve4s0_8` حقيقية ⇒ فلا زرّ كان يُحقن هناك.
   *   والحاضن المقيس هو العنصر المخصّص `ytmusic-player-bar` وداخله `.right-controls`
   *   (أبناء الشريط: left 0..280 · middle 280..968 · right 968..1252 من شريط
   *   عرضه 1252px وارتفاعه 72px). وزرّ بارتفاع 32px مُدرَج في `.right-controls`
   *   **يُرسم مرئياً**: `w=53 h=32` عند `y=713`، و`overflow` الأب `visible` ⇒ لا قصّ.
   *   و`.middle-controls` **مرفوض بالقياس**: `overflow: hidden` يقصّ ما يُدرج فيه.
   */
  const HOST_SELECTORS = ['.ytp-right-controls', 'ytmusic-player-bar .right-controls'];
  /** الشريط الحاضن للأزرار، أو `null` إن لم يكن أيّهما في الصفحة بعد. */
  function hostBar() {
    for (const sel of HOST_SELECTORS) {
      const n = document.querySelector(sel);
      if (n) return n;
    }
    return null;
  }

  function tryInject() {
    const isNewVideo = (currentVideoUrl !== location.href);
    // Buttons persisted across an SPA navigation: still re-check the video.
    if (document.getElementById(BTN_PROC)) {
      // الزرّ موجود ولا نملكه ⇒ نسخة أخرى حقنت قبلاً (التعليل في تعليق FOREIGN_BAR).
      if (!procBtn) noteForeignBar();
      if (isNewVideo) {
        currentVideoUrl = location.href;
        checkStatusForCurrentVideo();
      }
      return true;
    }
    const controls = hostBar();
    if (!controls) return false;
    const mb = makeModeBtn();
    const wb = makeWatchBtn();
    const pb = makeProcBtn();
    // الإدراج بترتيب معكوس لأن `prepend` يضع في المقدّمة ⇒ الترتيب المعروض
    // (معالجة · مشاهدة · الوضع) في الشريطين معاً.
    controls.prepend(mb);
    controls.prepend(wb);
    controls.prepend(pb);
    procBtn = pb;
    watchBtn = wb;
    modeBtn = mb;
    paintModeBtn();
    currentVideoUrl = location.href;
    checkStatusForCurrentVideo();
    return true;
  }

  // Audit E-3: YouTube is an SPA — navigation rebuilds the player controls
  // and the buttons vanish. Re-inject on `yt-navigate-finish` AND watch the
  // player container (NOT document.body — a body-wide subtree observer fires
  // on every progress-bar/comment mutation and drains CPU). Fall back to body
  // only if the player isn't there yet. A new video always resets the bar.
  let injectScheduled = false;
  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    setTimeout(() => {
      injectScheduled = false;
      tryInject();
    }, 200);
  }
  window.addEventListener('yt-navigate-finish', () => {
    stopPoll(); // orphaned polls must not drive the new page's buttons
    stopWatch(true);
    resetBar();
    scheduleInject();
  });
  window.addEventListener('yt-page-data-updated', scheduleInject);
  /* المَراصد: `#movie_player` (يوتيوب **و**يوتيوب-ميوزيك — `#movie_player` قائم
   * في كليهما بالقياس)، و**شريط YouTube Music** نفسه لأن `yt-navigate-finish`
   * **لا يُطلق هناك إطلاقاً**: قِيس صفر حدث في تحميل كامل، وصفر في تنقّل داخلي
   * حقيقي (نقرة `.next-button` نقلت إلى `watch?v=9waqGhS2RUI`)، ومع ذلك بقي
   * الشريط وأزراره في المستند ⇒ فالتغيّر يُلتقط بالرصد لا بالحدث.
   * والالتفاف بـ`try` مقصود: مراقب على عقدة غير موجودة **يرمي**، ورميه يُسقط بقية
   * الـIIFE — ومنها تسجيل `chrome.runtime.onMessage` في آخر الملف (أي أن زرّ
   * النافذة يتعطّل كلّه). قِيس الرمي فعلاً في الحقن المبكر عبر CDP (مسبار). */
  const observedRoots = [];
  function observeRoots() {
    const roots = [document.querySelector('#movie_player') || document.body,
      document.querySelector('ytmusic-player-bar')];
    const domObserver = new MutationObserver(scheduleInject);
    for (const root of roots) {
      if (!root || observedRoots.includes(root)) continue;
      try {
        domObserver.observe(root, { childList: true, subtree: true });
        observedRoots.push(root);
      } catch (e) { /* عقدة غير قابلة للرصد — لا يُسقط السكربت */ }
    }
  }
  observeRoots();
  window.addEventListener('yt-page-data-updated', observeRoots);

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tryInject() || tries > 120) clearInterval(timer);
  }, 1000);
// ── رسالة من نافذة الإضافة: تشغيل/إيقاف المشاهدة المفلترة ────────────────────
// النافذة لا تعرف الفيديو ولا حالة المشغّل؛ هذه الصفحة هي التي تعرفها، فتُنفّذ
// الطلب هنا وتُبلغ النافذة بالنتيجة. لا تُقرأ أي بيانات ولا يُرسل شيء للخارج.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'watch-toggle') return false;
  try {
    if (typeof WATCH !== 'undefined' && WATCH) {
      stopWatch();
      sendResponse({ ok: true, watching: false, foreignBar: FOREIGN_BAR });
    } else if (typeof startWatch === 'function') {
      void startWatch();
      sendResponse({ ok: true, watching: true, foreignBar: FOREIGN_BAR });
    } else {
      sendResponse({ ok: false, error: 'watch unavailable on this page', foreignBar: FOREIGN_BAR });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return true; // الرد متزامن لكن إبقاء القناة مفتوحة آمن
});
})();
