/* ── لوحة الإعدادات: الربط والأحداث والاستماع لتغيّر الإعدادات ────────────
 * نُقل من src/main.ts كما هو حرفياً: wireSettings() بكاملها (162 سطراً) —
 * فتح القائمة، ومفاتيح CUDA/الإشعارات/المعاينة/الاحتفاظ بالموسيقى/المراقبة/
 * التكامل/تيليجرام/النظام/الأدوات، وأحداث cuda-install وcuda-status و
 * settings-changed وtg-*، ونداء refreshAutostart/askAutostartOnce.
 * لم يتغيّر أي معرّف DOM (#settings-menu، #btn-settings، #setting-*،
 * #advanced-panel-container، #version-badge، #cuda-*، #tg-*، #btn-*)، ولا
 * أي مفتاح localStorage، ولا أي أمر (`cuda_install`، `cuda_status`،
 * `autostart_status`، `get_settings`، `push_log`، `tg_*`)، ولا أي مفتاح
 * ترجمة. الوحيد المضاف: `export`.
 * وم٤ أضاف: عنصر `#tg-group-mode` ومفتاح `hl.tg_group_mode` بمفتاحَي ترجمة
 * (`settings_group_mode` · `..._hint`) — والربط أدناه على نمط `#max-jobs` (م١)
 * حرفياً: التطبيع من `groupModeFrom` في settings.ts، لا نسخة ثانية هنا.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n';
import { trapFocus } from './util';
import { groupModeFrom, notifyWatchUiChanged, pushSettings, type RustSettings } from './settings';
import { showCudaHint, updateCudaBanner, refreshProviderLine, type CudaStatus } from './cuda';
import { askAutostartOnce, refreshAutostart, refreshBridgeExt } from './integration';
import { refreshYtdlpUpdateUi } from './ytdlpUi';

export function wireSettings(): void {
  const btnSettings = document.getElementById('btn-settings');
  const menu = document.getElementById('settings-menu');
  const cudaCheckbox = document.getElementById('setting-cuda') as HTMLInputElement;
  const notifyCheckbox = document.getElementById('setting-notify') as HTMLInputElement;

  // CUDA_RUNTIME_PLAN: progress + completion of the self-download.
  void listen<{ file: string; pct: number }>('cuda-install', (ev) => {
    showCudaHint(`${t('cuda_downloading')} ${ev.payload.file} — ${Math.round(ev.payload.pct * 100)}%`);
  });
  void listen<{ ok: boolean; error?: string }>('cuda-install-done', (ev) => {
    const cb = document.getElementById('setting-cuda') as HTMLInputElement | null;
    if (ev.payload.ok) {
      localStorage.setItem('hl.cuda', '1');
      if (cb) cb.checked = true;
      showCudaHint(t('cuda_ready'));
      invoke('push_log', { level: 'info', message: 'مكتبات CUDA ثُبّتت بنجاح ✓' });
    } else {
      // condition 3: fallback — DirectML stays active, nothing breaks.
      // Show the backend's own explanation (e.g. "not published yet").
      localStorage.setItem('hl.cuda', '0');
      if (cb) cb.checked = false;
      showCudaHint(ev.payload.error || t('cuda_download_failed'));
      invoke('push_log', { level: 'error', message: `فشل تنزيل CUDA: ${ev.payload.error}` });
    }
    if (cb) cb.disabled = false;
    pushSettings();
    void updateCudaBanner();
    // ن-٣: التثبيت قد يغيّر ما سيُجرَّب في الجلسة القادمة — والسطر يعرض آخر
    // جلسة **فعلاً**، فيُحدَّث من الحقيقة لا من نيّة التنزيل.
    void refreshProviderLine();
  });

  if (cudaCheckbox) {
    cudaCheckbox.checked = localStorage.getItem('hl.cuda') === '1';
    cudaCheckbox.addEventListener('change', async (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) {
        const st = await invoke<CudaStatus>('cuda_status').catch(() => null);
        if (st && !st.nvidia) {
          cudaCheckbox.checked = false;
          localStorage.setItem('hl.cuda', '0');
          showCudaHint('');
          pushSettings();
          return;
        }
        if (st && st.cuda) {
          showCudaHint(t('cuda_ready'));
          localStorage.setItem('hl.cuda', '1');
          pushSettings();
          void updateCudaBanner();
          return;
        }
        // runtime missing → one-time self-download, box stays checked while disabled
        cudaCheckbox.disabled = true;
        showCudaHint(`${t('cuda_downloading')} 0%`);
        invoke('install_cuda_runtime').catch((err) => {
          cudaCheckbox.disabled = false;
          cudaCheckbox.checked = false;
          localStorage.setItem('hl.cuda', '0');
          showCudaHint(t('cuda_download_failed'));
          pushSettings();
          console.error('install_cuda_runtime failed', err);
        });
        return;
      }
      showCudaHint('');
      localStorage.setItem('hl.cuda', '0');
      pushSettings();
      void updateCudaBanner();
    });
  }

  if (notifyCheckbox) {
    notifyCheckbox.checked = localStorage.getItem('hl.notify') === '1';
    notifyCheckbox.addEventListener('change', (e) => {
      localStorage.setItem('hl.notify', (e.target as HTMLInputElement).checked ? '1' : '0');
      pushSettings();
    });
  }

  // ق-١: يقرّر هذا المفتاح هل يفحص الإقلاع تحديث yt-dlp أصلاً (lib.rs)، فإن
  // أُطفئ لم يُنادَ ensure_updated ولا مرة — والصفّ يشرح الثمن بدل أن يمرّ صامتاً.
  // السجل يحمل '1' عند التشغيل و'0' عند الإطفاء (لا شيء ⇐ تشغيل، كالافتراضي).
  const ytdlpAuto = document.getElementById('setting-ytdlp-auto') as HTMLInputElement | null;
  if (ytdlpAuto) {
    ytdlpAuto.checked = localStorage.getItem('hl.ytdlp_auto') !== '0';
    ytdlpAuto.addEventListener('change', (e) => {
      localStorage.setItem('hl.ytdlp_auto', (e.target as HTMLInputElement).checked ? '1' : '0');
      refreshYtdlpUpdateUi();
      pushSettings();
    });
    refreshYtdlpUpdateUi();
  }

  // م١: سقف الفصول المتزامنة. القائمة تحمل 1 و2 وحدهما، والقيمة تُطبَّع هنا
  // أيضاً: قيمة دخيلة في localStorage (نسخة قديمة أو تعديل يدوي) تُصحَّح إلى
  // **1** (الافتراضيّ الآمن) بدل أن تُدفع إلى الخلف — ولا تُرفع إلى 2 إلا
  // باختيار صريح محفوظ. **والتطبيع نفسه في `collectSettings`**
  // (`clampConcurrentJobs` في settings.ts)، فالمعروض = المُرسَل إلى الخلف.
  const maxJobs = document.getElementById('max-jobs') as HTMLSelectElement | null;
  if (maxJobs) {
    maxJobs.value = localStorage.getItem('hl.max_jobs') === '2' ? '2' : '1';
    maxJobs.addEventListener('change', () => {
      const v = maxJobs.value === '1' ? '1' : '2';
      maxJobs.value = v;
      localStorage.setItem('hl.max_jobs', v);
      pushSettings();
    });
  }

  // م٤: وضوح رسائل المجموعة — عنصر `#tg-group-mode` **داخل قسم الإعدادات**
  // (قرار المالك: مثل هذا الخيار مكانه الإعدادات، لا الواجهة الرئيسية).
  // والقائمة تحمل `mentions` و`all` وحدهما، والتطبيع عبر `groupModeFrom` —
  // مصدر واحد يشاركه `collectSettings`، فالمعروض = المُرسَل إلى الخلف.
  const groupMode = document.getElementById('tg-group-mode') as HTMLSelectElement | null;
  if (groupMode) {
    groupMode.value = groupModeFrom(localStorage.getItem('hl.tg_group_mode'));
    groupMode.addEventListener('change', () => {
      const v = groupModeFrom(groupMode.value);
      groupMode.value = v; // قيمة دخيلة في DOM تُصحَّح قبل أن تُخزَّن
      localStorage.setItem('hl.tg_group_mode', v);
      pushSettings();
    });
  }

  if (btnSettings && menu) {
    let menuRelease: (() => void) | null = null;
    const closeMenu = (): void => {
      menu.classList.add('hidden');
      menuRelease?.();
      menuRelease = null;
    };
    btnSettings.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false' : 'true');
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      if (willOpen) {
        menu.classList.remove('hidden');
        if (menuRelease === null) menuRelease = trapFocus(menu);
        // ن-٣: المزوّد الفعّال يُقرأ عند **فتح** اللوحة لا عند الإقلاع وحده —
        // فآخر جلسة فصل قد تكون وقعت بعد الإقلاع (وقد تكون جرت من CLI).
        void refreshProviderLine();
      } else {
        closeMenu();
      }
      btnSettings.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target as Node) && !btnSettings.contains(e.target as Node)) {
        closeMenu();
        btnSettings.setAttribute('aria-expanded', 'false');
      }
    });
    // the settings popup counts as one of the app's dialogs — ESC closes it
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        closeMenu();
        btnSettings.setAttribute('aria-expanded', 'false');
        btnSettings.focus();
      }
    });
  }

  // Functional gap: `settings-changed` was emitted but never listened to, so
  // an external edit of settings.json was silently clobbered. Converge the
  // read-only indicators on backend truth (safe with the 300ms push
  // debounce: rapid local toggles collapse into one push before any echo).
  void listen<RustSettings>('settings-changed', (ev) => {
    const s = ev.payload;
    if (!s || typeof s !== 'object') return;
    if (typeof s.cuda === 'boolean') {
      localStorage.setItem('hl.cuda', s.cuda ? '1' : '0');
      const cb = document.getElementById('setting-cuda') as HTMLInputElement | null;
      if (cb) cb.checked = s.cuda;
      void updateCudaBanner();
      void refreshProviderLine();
    }
    if (typeof s.notify === 'boolean') {
      localStorage.setItem('hl.notify', s.notify ? '1' : '0');
      const cb = document.getElementById('setting-notify') as HTMLInputElement | null;
      if (cb) cb.checked = s.notify;
    }
    if (typeof s.watch_enabled === 'boolean') {
      localStorage.setItem('hl.watch', s.watch_enabled ? '1' : '0');
      const cb = document.getElementById('setting-watch') as HTMLInputElement | null;
      if (cb) cb.checked = s.watch_enabled;
    }
    if (typeof s.bridge_enabled === 'boolean') {
      localStorage.setItem('hl.bridge', s.bridge_enabled ? '1' : '0');
      const cb = document.getElementById('setting-bridge') as HTMLInputElement | null;
      if (cb) cb.checked = s.bridge_enabled;
  void refreshBridgeExt();
  void refreshAutostart();
  void invoke<{ enabled: boolean }>('autostart_status')
    .then((r) => askAutostartOnce(s.autostart_asked === true, !!r.enabled))
    .catch(() => { /* لا سؤال إن تعذّرت القراءة */ });
    }
    // Sprint T1: the Telegram worker rewrites these itself on a successful
    // pairing, so the panel must follow backend truth (never a stale cache).
    if (typeof s.telegram_enabled === 'boolean') {
      localStorage.setItem('hl.tg', s.telegram_enabled ? '1' : '0');
      const cb = document.getElementById('setting-telegram') as HTMLInputElement | null;
      if (cb) cb.checked = s.telegram_enabled;
    }
    if (typeof s.telegram_user_id === 'string') {
      localStorage.setItem('hl.tg_owner', s.telegram_user_id);
      const inp = document.getElementById('tg-owner') as HTMLInputElement | null;
      if (inp && inp.value !== s.telegram_user_id) inp.value = s.telegram_user_id;
    }
    if (typeof s.watch_path === 'string') localStorage.setItem('hl.watch_path', s.watch_path);
    // م٤: القائمة تتبع حقيقة الخلف كجيرانها (telegram_enabled/telegram_user_id) —
    // وقيمة الخلف تمرّ بـ`groupModeFrom` فلا تُدخل قيمة ثالثة إلى التخزين.
    if (typeof s.telegram_group_mode === 'string') {
      const v = groupModeFrom(s.telegram_group_mode);
      localStorage.setItem('hl.tg_group_mode', v);
      const sel = document.getElementById('tg-group-mode') as HTMLSelectElement | null;
      if (sel && sel.value !== v) sel.value = v;
    }
    notifyWatchUiChanged();
  });
}
