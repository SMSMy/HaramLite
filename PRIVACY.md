# Privacy Policy — HaramLite Bridge (browser extension)

**Last updated: 2026-09-25**

HaramLite Bridge is a companion extension for the **HaramLite** desktop application, which the user installs and
runs on their own computer. The extension exists for one purpose: to hand a video link the user explicitly chose
to that local application, and to show the processing controls on the page being watched.

## What the extension does NOT do

- It does **not** collect, store, or transmit any personal data.
- It does **not** send anything to the developer or to any third party.
- It contains **no analytics, no advertising, no tracking, and no remote code**. All of its code ships inside the
  package; it never downloads or evaluates code from a server.
- It does **not** read your browsing history, and it does not read any tab you have not acted on.

## What it handles, and where it stays

| Item | Where it goes |
|---|---|
| Two user preferences — the preferred processing mode (Song / Clip) and the interface language (Arabic / English) | Stored locally in `chrome.storage.local` on the user's own device, so the last choice persists. Never transmitted anywhere. |
| The URL of the page/link the user explicitly chose to process, plus the selected mode | Sent over the **local Native Messaging channel** to the HaramLite application installed on the same machine. |
| Short status messages (for example: "link received", "processing started") | Exchanged with that same local application, so the page can show progress. |

Everything the desktop application produces — downloaded media, separated audio, and its settings — is written to
the user's own folders on the user's own machine. No part of that data reaches the developer.

## Permissions and why they are requested

- **`nativeMessaging`** — the only channel to the locally installed HaramLite application. There is no remote server.
- **`storage`** — to keep the two local preferences above.
- **`contextMenus`** — to add the right-click entries ("Send link", "Send page", "Send video", "Song mode", "Clip mode").
- **`activeTab`** — to read the current tab's URL only at the moment the user clicks the extension.
- **Host permission `*://*.youtube.com/*`** — the content script runs **only** on YouTube and YouTube Music, to place
  the processing controls in the player bar and to play back audio that the user's own machine produced locally.
  It is inactive on every other site.

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

Any change to this policy will appear as a new revision of this file in the project's public repository.

## Contact

Questions or reports: open an issue in the project repository — https://github.com/SMSMy/HaramLite/issues

---

## بالعربية (خلاصة)

إضافة **HaramLite Bridge** مرافق لتطبيق **HaramLite** الذي يُثبّته المستخدم ويعمل على جهازه. **لا تجمع الإضافة أي
بيانات ولا ترسل شيئاً إلى المطوّر أو إلى أي طرف ثالث**، ولا تحتوي على تحليلات أو إعلانات أو تتبّع أو شيفرة عن بُعد.
ولا تقرأ سجلّ التصفّح ولا أي تبويب لم يتفاعل معه المستخدم.

ما تتعامل معه: **تفضيلان محليان** (وضع المعالجة Song/Clip ولغة الواجهة) يُحفظان في `chrome.storage.local` على جهاز
المستخدم، **والرابط الذي اختاره صراحةً مع الوضع المختار** يُمرَّران عبر **قناة Native Messaging المحلية** إلى تطبيق
HaramLite على الجهاز نفسه، ومعهما **رسائل حالة قصيرة**. وكل ما ينتجه التطبيق (الوسائط والملفات وإعداداته) يُكتب في
مجلدات المستخدم على جهازه. وسكربت الصفحة يعمل **على يوتيوب ويوتيوب ميوزيك وحدهما** لوضع أزرار المعالجة وتشغيل
الصوت المُنتَج محلياً، ولا يعمل على أي موقع آخر.
