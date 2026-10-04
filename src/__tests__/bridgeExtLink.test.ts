/* ── د1 · زر «صفحة إضافة المتصفح» يفتح فعلاً ──────────────────────────────
 *
 * **العلّة المقيسة** (بلاغ د1 على `8b2295a`): التفويض الوحيد لسمة
 * `data-open-url` مسجَّل على `#about-body` في `src/aboutUpdate.ts`، وزرّ
 * `#bridge-ext-link` يعيش في تبويب التكامل ⇒ **خارج نطاق المفوَّض** ⇒ نقرة
 * صامتة، وهو يظهر **بالضبط** حين لم تتصل أي إضافة بعد (`renderBridgeExt`
 * يعرضه عند `!extension_seen`) — أول خطوة لتثبيت الإضافة.
 *
 * **ما يقيسه**: يقرأ `index.html` نفسه، يربط `wireBridge()` كما يربطها
 * `main.ts`، ينقر الزرّ، ويقيس نداء `openUrl` **بالرابط الحرفي من السمة**.
 *
 * **ما لا يقيسه (بصراحة)**: فتح الرابط خارج التطبيق (عملية النظام) — المقيس
 * أن النداء وصل بالمفتاح الصحيح لا أن متصفحاً فتح؛ والظهور البصري للزرّ
 * يقيسه `renderBridgeExt` منفرداً.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const h = vi.hoisted(() => ({
  openUrl: vi.fn(async () => undefined),
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: h.openUrl }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { wireBridge } from '../integration';

function mountApp(): void {
  document.body.innerHTML = (new DOMParser().parseFromString(indexHtml as string, 'text/html')).body.innerHTML;
}

const link = (): HTMLButtonElement => document.getElementById('bridge-ext-link') as HTMLButtonElement;

describe('د1 · نقر #bridge-ext-link يفتح صفحة الإضافة', () => {
  beforeEach(() => {
    h.openUrl.mockClear();
    h.invoke.mockClear();
    mountApp();
  });

  it('النقر ⇒ openUrl بالرابط الحرفي من data-open-url', () => {
    expect(link(), 'الزر غاب من index.html — الفحص باطل').not.toBeNull();
    expect(link().getAttribute('data-open-url'), 'السمة غابت — الفحص باطل').toBe(
      'https://haramlite.com/bridge.html',
    );
    wireBridge();
    // `renderBridgeExt` يُظهر الزرّ حين لا إضافة متصلة؛ jsdom لا يحجب النقر
    // بحجم مخفيّ، فنُظهره لطابق مسار الإنتاج الذي يمرّ فيه النقر فعلاً.
    link().classList.remove('hidden');
    link().dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(h.openUrl, 'النقر لم يفتح شيئاً — الزرّ ميت').toHaveBeenCalledTimes(1);
    expect(h.openUrl).toHaveBeenCalledWith('https://haramlite.com/bridge.html');
  });

  it('وبدون ربط wireBridge لا يوجد مستمع — يثبت أن النداء من الربط لا من السمة', () => {
    link().classList.remove('hidden');
    link().dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(h.openUrl).not.toHaveBeenCalled();
  });
});
