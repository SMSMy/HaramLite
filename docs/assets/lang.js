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
  /* الوسوم الوحيدة المسموح بها داخل قيمة ترجمة. محصورة عمداً: القيم في
     صفحات الموقع لا تحمل غير <b> و<code>، وأي وسم آخر (‏img/script/iframe)
     يُطرح نصّاً لا عنصراً — فلا تصير سمة الترجمة باباً لحقن وسم. */
  var RICH_TAGS = { B: 1, STRONG: 1, CODE: 1 };
  function hasElementChildren(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 1) return true;
    }
    return false;
  }
  /* وسم مسموح ⇒ يُبنى من جديد **بلا أي سمة**؛ وغير المسموح ⇒ عقدة نصّية.
     البناء من جديد لا نسخ العقدة، فلا يبقى `onclick` ولا `src` ولا غيرهما. */
  function safeNode(source, host) {
    if (source.nodeType === 3) return host.createTextNode(source.nodeValue);
    if (source.nodeType !== 1 || !RICH_TAGS[source.tagName]) {
      return host.createTextNode(source.textContent || '');
    }
    var node = host.createElement(source.tagName.toLowerCase());
    for (var i = 0; i < source.childNodes.length; i++) {
      node.appendChild(safeNode(source.childNodes[i], host));
    }
    return node;
  }
  /* يكتب قيمة الترجمة على عنصر له أبناء عنصرية **بلا هدم ترميزه**: يبني شجرة
     آمنة من القيمة ويستبدل بها محتوى العنصر، بدل `textContent` التي تمحو
     الأبناء كلهم.
       - عنصر قيمته موجّهة إلى `data-i18n-attr` (‏video-shell: aria-label)
         **يُستثنى تماماً** — فسمة `data-i18n-ar` عنده ليست نصّاً مقصوداً به،
         وكانت الكتابة عليه تهدم غلاف الفيديو. (‏TRANSPARENCY لا تحمل
         `data-i18n-attr`، فنصّها يُترجم كما هو مقصود.)
       - **ولا يُسلَك هذا المسار أصلاً لقيمة بلا وسم**: عنصر أبناؤه عناصر
         وتكتب له سمةٌ نصّاً بلا وسوم ليس نصّه المقصود (‏TRANSPARENCY:72 —
         السمة «تدقيق من الشيفرة · 0.2.7» والابن `js-release-tag` يحمل الرقم
         الحيّ). فتُترك بناؤه كما هي بدل محو ابنها.
       - والوسوم المسموح بها (`RICH_TAGS`) تُبنى عناصر بلا أي سمة، وغيرها
         يُطرح نصّاً — فلا تصير سمة الترجمة باباً لحقن وسم (`<img onerror>`).
     (وغير هذا المسار يبقى على `textContent` كما كان: أبسط وأسرع.) */
  function setI18nContent(el, value) {
    var doc = el.ownerDocument;
    var tpl = doc.createElement('template');
    tpl.innerHTML = value;
    var frag = doc.createDocumentFragment();
    var nodes = tpl.content.childNodes;
    for (var j = 0; j < nodes.length; j++) frag.appendChild(safeNode(nodes[j], doc));
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(frag);
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
      if (!t) return;
      var v = fill(t);
      if (!hasElementChildren(el)) { el.textContent = v; return; }
      /* وسمٌ على عنصر له أبناء عنصرية: مسار غنيّ آمن — إلا أن تكون قيمته
         موجّهة إلى `data-i18n-attr` (فليست نصّه) أو بلا وسم (فلا شيء يُبنى
         وتُترك بناؤه كما هي). */
      if (el.hasAttribute('data-i18n-attr') || v.indexOf('<') === -1) return;
      setI18nContent(el, v);
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
