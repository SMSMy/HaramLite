/* ملف الترجمة المشترك لصفحات الموقع — يستعمله الهيدر/الفوتر الموحّد.
   المفتاح hl.lang هو نفسه في الرئيسية وصفحة الإضافة، فالاختيار يسري على
   الموقع كله. الصيغة: [data-i18n-ar] مع [data-i18n-en]. */
(function () {
  var KEY = 'hl.lang';
  function apply(lang) {
    var l = lang === 'en' ? 'en' : 'ar';
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n-ar]').forEach(function (el) {
      var t = el.getAttribute(l === 'ar' ? 'data-i18n-ar' : 'data-i18n-en');
      if (t) el.textContent = t;
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      var a = el.getAttribute('data-i18n-attr');
      var v = el.getAttribute(l === 'ar' ? 'data-i18n-ar' : 'data-i18n-en');
      if (a && v) el.setAttribute(a, v);
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
