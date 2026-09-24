/* ── شاشة الإعدادات في نافذتها المستقلة ──────────────────────────────────
 * قرار المالك (2026-09-23): «القائمة المنسدلة أصبحت طويلة» ⇒ **نافذة مستقلة**
 * فيها **شاشة إعدادات كاملة** بسبعة تبويبات.
 *
 * **والصفحة واحدة**: نافذة الإعدادات تفتح `index.html` نفسه (لا صفحة ثانية ولا
 * مدخل بناء ثانٍ)، والوضع يُقرأ من **لابل النافذة** (`apps/web` لا يلزمه IPC:
 * `getCurrentWindow().label` خاصيّة محليّة في `@tauri-apps/api/window`). فإن
 * تعذّر قراءة اللابل (بيئة اختبار أو متصفّح) رجعنا إلى `location.hash` — بديلٌ
 * صريح لا تخمين.
 *
 * **ومصدر حالة واحد**: الشاشة **هي** العناصر نفسها (`#setting-*`، `#max-jobs`،
 * `#tg-*`…) التي تربطها `settingsPanel.ts`؛ فليس هنا نسخة ثانية من أي قيمة ولا
 * من أي نداء — التبديل يظهر/يُخفي حاويات، والكتابة تمرّ من `pushSettings()`
 * القائم، والرئيسية تتحدّث بحدث `settings-changed` القائم.
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

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

/** لابل النافذة المستقلة — وهو ما يقرؤه وضع الشاشة. */
export const SETTINGS_WINDOW_LABEL = 'settings';

/**
 * هل نحن في نافذة الإعدادات؟ — دالّة **خالصة** (تُقاس في jsdom بلا tauri).
 *
 * والترتيب مقصود: اللابل أوّلاً (الحقيقة في التطبيق)، ثم `location.hash` كبديل
 * صريح (اختبار/متصفّح)، ولا شيء آخر.
 */
export function isSettingsMode(label: string | null | undefined, hash?: string): boolean {
  if (label) return label === SETTINGS_WINDOW_LABEL;
  return (hash ?? '').replace(/^#/, '') === SETTINGS_WINDOW_LABEL;
}

/**
 * يقرأ لابل النافذة الحالية من الواجهة إن أمكن، وإلا يرجع `null` فيُستعمل
 * الـhash. **ولا يفشل**: `getCurrentWebviewWindow()` ترمي خارج tauri، والرمي هنا
 * ليس عطلاً بل «لستُ في نافذة tauri» — وهو حال الاختبار والمتصفّح.
 *
 * والقراءة من **الواجهة الرسمية** (`@tauri-apps/api/webviewWindow`، نفس ما
 * يستعمله `main.ts:181`) لا من نسخة أو من `window.__TAURI_INTERNALS__` يدوياً.
 */
export function currentWindowLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

/** يُظهر تبويباً ويُخفي البقية، ويُعلن الحالة على الأزرار (`aria-selected`). */
export function showTab(doc: Document, tab: SettingsTab): void {
  for (const panel of Array.from(doc.querySelectorAll<HTMLElement>('.settings-tab-panel'))) {
    panel.hidden = panel.dataset.tab !== tab;
  }
  for (const btn of Array.from(doc.querySelectorAll<HTMLElement>('[data-tab-btn]'))) {
    btn.setAttribute('aria-selected', btn.dataset.tabBtn === tab ? 'true' : 'false');
  }
}

/**
 * يضبط الوضع: في نافذة الإعدادات **تظهر الشاشة** ويُخفى ما ليس منها؛ وفي
 * الرئيسية **لا تظهر أبداً**.
 *
 * **ولا مسار ثانٍ**: الحاوية (`#settings-menu` — معرّف تاريخي) لا تُفتح في
 * الرئيسية بأي حال: يُفرض `hidden` هناك ولا يملك أي زرّ إظهارها.
 */
export function applySettingsMode(doc: Document, inSettingsWindow: boolean): void {
  const body = doc.body;
  const screen = doc.getElementById('settings-menu');
  if (!screen) return;
  if (inSettingsWindow) {
    body.classList.add('settings-mode');
    screen.classList.remove('hidden');
    screen.setAttribute('aria-modal', 'true');
    showTab(doc, 'performance');
  } else {
    body.classList.remove('settings-mode');
    // **الرئيسية: مخفيّة دائماً** — الزرّ يفتح نافذة، لا قائمة.
    screen.classList.add('hidden');
    screen.setAttribute('aria-modal', 'false');
  }
}

/** يربط أزرار التبويبات (كانت أزراراً حقيقيّة: تُنقر وتُعلن حالتها). */
export function wireTabButtons(doc: Document): void {
  for (const btn of Array.from(doc.querySelectorAll<HTMLElement>('[data-tab-btn]'))) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.tabBtn;
      if (name && (SETTINGS_TABS as readonly string[]).includes(name)) {
        showTab(doc, name as SettingsTab);
      }
    });
  }
}

/** يفتح نافذة الإعدادات المستقلة (الأمر في `lib.rs`، بلا صلاحيات جديدة). */
export async function openSettingsWindow(): Promise<void> {
  try {
    await invoke('open_settings');
  } catch (err) {
    // **لا صمت**: تعذّر الفتح يُسجَّل (ولا بديل في الواجهة عن النافذة).
    try {
      await invoke('push_log', {
        level: 'error',
        message: `تعذّر فتح نافذة الإعدادات: ${String(err)}`,
      });
    } catch {
      /* السجلّ نفسه قد يكون غائباً في بيئة الاختبار */
    }
  }
}

/**
 * يُنادى مرّة عند الإقلاع: يضبط الوضع ويربط التبويبات، ويُبقي الشاشة مخفيّة في
 * الرئيسية. **مُصدَّر ليُقاس** في jsdom (الحرّاس الأربعة).
 */
export function wireSettingsScreen(doc: Document = document): void {
  applySettingsMode(doc, isSettingsMode(currentWindowLabel(), doc.defaultView?.location.hash));
  wireTabButtons(doc);
}
