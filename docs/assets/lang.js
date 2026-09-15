/* ملف الترجمة المشترك لصفحات الموقع — يستعمله الهيدر/الفوتر الموحّد.
   المفتاح hl.lang هو نفسه في الرئيسية وصفحة الإضافة، فالاختيار يسري على
   الموقع كله. الصيغة: [data-i18n-ar] مع [data-i18n-en].

   الاتجاه لا يتبع لغة الواجهة، بل وجود نسخة إنجليزية من **متن الصفحة**:
   في صفحات الأدلة والسياسات لا يُترجم إلا الهيدر والفوتر والمتن عربي، فقلب
   dir إلى ltr هناك يعرض نصاً عربياً بمحاذاة لاتينية. (وهو ما كان يقع: كان
   القلب يتم بمجرّد أن تكون لغة الواجهة en، بصرف النظر عن وجود ترجمة.)
   فالقاعدة الآن: تبقى الصفحة rtl ما لم تُعلن على <html> السمة
   data-i18n-edition="en" — والرئيسية وصفحة الإضافة وحدهما تعلنانها لأن
   متنهما مترجم فعلاً. إضافة السمة لصفحة بلا ترجمة تعني قلب اتجاه نص عربي.

   ولهذا لا يصلح documentElement.lang دليلاً على لغة الواجهة في سكربتات
   الصفحات (إشعار «المتن عربي فقط»): استعمل HaramLiteLang.current(). */
(function () {
  var KEY = 'hl.lang';
  /* الرقم الذي يُستبدل به {v}: من العنصر الذي يحمله في الصفحة (js-version-text)
     أو من كائن الصفحة، وإلا فمن الاحتياطي. بلا هذا كان هذا الملف يكتب نصّ
     السمة كما هو فيظهر «{v}» حرفياً للزائر — وهو ما حدث فعلاً بعد نشر 0.2.4:
     كائن الرئيسية يستبدل ثم يطمس هذا الملف نصّه لأنه يعمل بعده. */
  function version() {
    var el = document.querySelector('.js-version-text');
    var fromDom = el && el.textContent ? el.textContent.trim() : '';
    if (fromDom) return fromDom;
    var state = window.HaramLiteState;
    if (state && state.version) return String(state.version);
    return '0.2.5';
  }
  function fill(t) {
    return String(t).replace(/\{v\}/g, version());
  }
  function apply(lang) {
    var l = lang === 'en' ? 'en' : 'ar';
    // نسخة إنجليزية للمتن: تُعلَن ولا تُستنتج
    var contentEn = document.documentElement.getAttribute('data-i18n-edition') === 'en';
    var doc = contentEn ? l : 'ar';
    document.documentElement.lang = doc;
    document.documentElement.dir = doc === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n-ar]').forEach(function (el) {
      var t = el.getAttribute(l === 'ar' ? 'data-i18n-ar' : 'data-i18n-en');
      if (t) el.textContent = fill(t);
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      var a = el.getAttribute('data-i18n-attr');
      var v = el.getAttribute(l === 'ar' ? 'data-i18n-ar' : 'data-i18n-en');
      if (a && v) el.setAttribute(a, fill(v));
    });
    var lab = document.getElementById('lang-btn-label');
    if (lab) lab.textContent = l === 'ar' ? 'English' : 'العربية';
    try { localStorage.setItem(KEY, l); } catch (e) {}
  }
  function current() {
    try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'ar'; } catch (e) { return 'ar'; }
  }
  window.HaramLiteLang = { apply: apply, current: current, KEY: KEY };
  document.addEventListener('DOMContentLoaded', function () {
    apply(current());
    var btn = document.getElementById('lang-btn');
    if (btn) btn.addEventListener('click', function () { apply(current() === 'ar' ? 'en' : 'ar'); });
  });
})();
