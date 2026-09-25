/* ── شاشة الإعدادات **داخل نافذة التطبيق** ────────────────────────────────
 * قرار المالك (2026-09-23): «القائمة المنسدلة أصبحت طويلة» ⇒ شاشة كاملة.
 * وقراره النهائي (2026-09-24): **إلغاء النافذة المستقلة** — لأنها صارت **نافذة
 * العملية الرئيسية** (`MainWindowTitle = "HaramLite — الإعدادات"`)، وبيضاء،
 * و**بقيت عالقة بعد إغلاق التطبيق** حتى أُنهيت عملياته يدوياً (`HaramLite = 0`).
 * فالمسار الثاني أضاف صنف عطب كاملاً (إقلاع ثانٍ · هوية نافذة · عمرٌ لا يتبع عمر
 * التطبيق) مقابل مكسب صفر ⇒ فالإعدادات **شاشة داخل النافذة الواحدة**.
 *
 * **والوضع من حالة داخلية** (`screenOn` أدناه + زرّان)، **ولا يُقرأ لابل نافذة
 * إطلاقاً** — و`location.hash` باقٍ **بديلاً للاختبار فقط** (‏`wireSettingsScreen`).
 *
 * **ومصدر حالة واحد**: الشاشة **هي** العناصر نفسها (`#setting-*` · `#max-jobs` ·
 * `#tg-*`…) التي تربطها `settingsPanel.ts`؛ فليس هنا نسخة ثانية من أي قيمة ولا من
 * أي نداء — التبديل يُظهر/يُخفي، والكتابة تمرّ من `pushSettings()` القائم،
 * والواجهة تتحدّث بحدث `settings-changed` القائم.
 *
 * **والحالة محفوظة ما دام التطبيق يعمل**: لا إخفاء لنافذة ولا تدمير — الشاشة
 * تُبدَّل داخل نفس الـDOM، والتبويب المختار (`currentTab`) يُحفظ ويُعاد عند
 * العودة، وقيمةٌ في حقل لم تُحفظ تبقى في مكانها.
 */

/** تبويبات الشاشة — **الترتيب هو ترتيب الأزرار والحاويات** (تُطابَق بالاسم). */
export const SETTINGS_TABS = [
  'performance',
  'engine',
  'watch',
  'bridge',
  'telegram',
  'update',
  'about',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** الوضع الداخلي — **المصدر الوحيد** لحال «أنا في الإعدادات». */
let screenOn = false;

/** التبويب المختار — **محفوظ** ليعود كما كان عند إعادة الدخول. */
let currentTab: SettingsTab = 'performance';

/** هل نحن في شاشة الإعدادات الآن؟ (يُقاس في الاختبار) */
export function settingsScreenIsOn(): boolean {
  return screenOn;
}

/** التبويب المختار الآن (يُقاس في الاختبار) */
export function settingsScreenTab(): SettingsTab {
  return currentTab;
}

/** يُظهر تبويباً ويُخفي البقية، ويُعلن الحالة على الأزرار (`aria-selected`). */
export function showTab(doc: Document, tab: SettingsTab): void {
  currentTab = tab;
  for (const panel of Array.from(doc.querySelectorAll<HTMLElement>('.settings-tab-panel'))) {
    panel.hidden = panel.dataset.tab !== tab;
  }
  for (const btn of Array.from(doc.querySelectorAll<HTMLElement>('[data-tab-btn]'))) {
    btn.setAttribute('aria-selected', btn.dataset.tabBtn === tab ? 'true' : 'false');
  }
}

/**
 * يضبط الوضع: داخل الشاشة **تظهر الشاشة**، ويُخفى `<main>` بـ`settings-mode`؛
 * وخارجها العكس.
 *
 * **وضمانة «لا شاشة فارغة»**: لا يُضاف `settings-mode` (الذي يُخفي `<main>`) إلا
 * إذا كانت الشاشة **ظاهرة فعلاً** — وإلا بقي العرض الرئيسي كما هو، فلا تبقى
 * النافذة بلا مرئيّ (وهو صنف العطب الذي أُبلغ عنه ميدانياً).
 */
export function applySettingsMode(doc: Document, on: boolean): void {
  const body = doc.body;
  const screen = doc.getElementById('settings-menu');
  if (!screen) return;
  if (on) {
    screen.classList.remove('hidden');
    if (screen.classList.contains('hidden')) {
      // الحاوية غير قابلة للإظهار ⇒ لا نُخفِي المحتوى الرئيسي بلا بديل.
      screenOn = false;
      body.classList.remove('settings-mode');
      return;
    }
    screenOn = true;
    body.classList.add('settings-mode');
    screen.setAttribute('aria-modal', 'true');
    showTab(doc, currentTab); // **يُعاد التبويب المحفوظ** لا الأوّل دائماً
  } else {
    screenOn = false;
    body.classList.remove('settings-mode');
    screen.classList.add('hidden');
    screen.setAttribute('aria-modal', 'false');
  }
}

/** يفتح شاشة الإعدادات داخل النافذة (نداء زرّ الإعدادات). */
export function openSettingsScreen(doc: Document = document): void {
  applySettingsMode(doc, true);
}

/** زرّ الرجوع/الإغلاق في الشاشة: يعيد العرض الرئيسي — **بلا إخفاء ولا تدمير**. */
export function closeSettingsScreen(doc: Document = document): void {
  applySettingsMode(doc, false);
}

/** يربط أزرار التبويبات وزرّ الرجوع. */
export function wireTabButtons(doc: Document): void {
  for (const btn of Array.from(doc.querySelectorAll<HTMLElement>('[data-tab-btn]'))) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.tabBtn;
      if (name && (SETTINGS_TABS as readonly string[]).includes(name)) {
        showTab(doc, name as SettingsTab);
      }
    });
  }
  doc.getElementById('settings-close')?.addEventListener('click', () => {
    closeSettingsScreen(doc);
  });
}

/**
 * يُنادى مرّة عند الإقلاع: يضبط الوضع الأوّلي ويربط التبويبات وزرّ الرجوع.
 *
 * **والوضع الأوّلي من `location.hash` وحده** — بديلٌ **للاختبار** (`#settings`)،
 * **ولا قراءة لابل نافذة إطلاقاً**. وفي التطبيق الحقيقي يبدأ الوضع **مطفأً**
 * ويُفتح بالزرّ.
 */
export function wireSettingsScreen(doc: Document = document): void {
  const want = (doc.defaultView?.location.hash ?? '').replace(/^#/, '') === 'settings';
  applySettingsMode(doc, want);
  wireTabButtons(doc);
}
