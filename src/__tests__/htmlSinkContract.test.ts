/* ── د-٩ — عقد مصرفَي HTML في سطر الحكم (src/media.ts) ────────────────────
 * media.ts يفصل المصرفين عمداً:
 *   setVerdict()     → textContent: رسائل الخلف والمسارات تمرّ منه ⇒ لا وسم.
 *   setVerdictHtml() → innerHTML: الوسم الساكن في verdictHtml() وحده.
 * الاختبار يثبّت **الاتجاهين معاً**: إرخاء الأول = XSS في WebView (ملف باسم
 * `<img onerror=…>.mp3`)، وتشديد الثاني (تهريب الوسم) = انحدار وظيفي.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setVerdict, setVerdictHtml, verdictHtml } from '../media';
import { applyLang, t } from '../i18n';
import mainSource from '../main.ts?raw';
import mediaSource from '../media.ts?raw';
import queueSource from '../queue.ts?raw';

const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
/** The concrete WebView vector named in the media.ts:21-24 comment: a *file*
 *  whose name carries the markup, arriving through a backend error string. */
const FILE_PAYLOAD = 'C:\\music\\<img src=x onerror=alert(1)>.mp3';
const BACKEND_ERROR = `probe_media failed: No such file or directory (os error 2): ${FILE_PAYLOAD}`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('د-٩ · setVerdict is a plain-text sink', () => {
  it('creates no <img> (and no element at all) and shows the payload as raw text', () => {
    const host = document.createElement('div');
    document.body.append(host);

    setVerdict(host, IMG_PAYLOAD);

    expect(document.querySelector('img')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(host.children).toHaveLength(0);
    expect(host.childNodes).toHaveLength(1);
    expect(host.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(host.textContent).toBe(IMG_PAYLOAD);
    expect(host.innerHTML).not.toContain('<img');
    expect(host.innerHTML).toContain('&lt;img');
  });

  it('keeps a backend error string carrying a hostile file name inert', () => {
    const host = document.createElement('div');
    document.body.append(host);

    setVerdict(host, BACKEND_ERROR, true);

    expect(document.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('*')).toHaveLength(0);
    expect(host.textContent).toBe(BACKEND_ERROR);
  });

  it('toggles the two state classes without touching the text', () => {
    const host = document.createElement('div');

    setVerdict(host, 'bad', true);
    expect(host.classList.contains('text-error')).toBe(true);
    expect(host.classList.contains('text-on-surface-variant')).toBe(false);

    setVerdict(host, IMG_PAYLOAD, false);
    expect(host.classList.contains('text-error')).toBe(false);
    expect(host.classList.contains('text-on-surface-variant')).toBe(true);
    expect(host.textContent).toBe(IMG_PAYLOAD);
  });

  it('is a no-op on a missing element (probeEl() may return null) and never throws', () => {
    expect(() => setVerdict(null, IMG_PAYLOAD)).not.toThrow();
    expect(document.querySelector('img')).toBeNull();
  });

  it('control: the very same string through innerHTML IS parsed into an <img>', () => {
    // Non-vacuity control — proves the payload is a live vector in this
    // environment, so the assertions above are not passing by accident.
    const probe = document.createElement('div');
    probe.innerHTML = IMG_PAYLOAD;
    expect(probe.querySelector('img')).not.toBeNull();
  });
});

describe('د-٩ · setVerdictHtml stays a rich sink (static markup only)', () => {
  it('renders verdictHtml("video") as elements, not as escaped text', () => {
    const host = document.createElement('div');
    setVerdictHtml(host, verdictHtml('video'));

    const label = host.querySelector('span[data-i18n="out_type_label"]');
    const value = host.querySelector('span[data-i18n="out_video"]');
    expect(label).not.toBeNull();
    expect(value).not.toBeNull();
    expect(label?.textContent).toBe(t('out_type_label'));
    expect(value?.textContent).toBe(t('out_video'));
    expect(host.textContent).not.toContain('<span');
  });

  it('renders the audio variant (and not the video one)', () => {
    const host = document.createElement('div');
    setVerdictHtml(host, verdictHtml('audio'));

    expect(host.querySelector('[data-i18n="out_audio"]')?.textContent).toBe(t('out_audio'));
    expect(host.querySelector('[data-i18n="out_video"]')).toBeNull();
    expect(host.querySelectorAll('span')).toHaveLength(2);
  });

  it('keeps the injected markup relabelable by a later applyLang()', () => {
    const host = document.createElement('div');
    document.body.append(host);
    setVerdictHtml(host, verdictHtml('video'));

    applyLang();

    expect(host.querySelector('[data-i18n="out_video"]')?.textContent).toBe(t('out_video'));
    expect(host.querySelectorAll('span')).toHaveLength(2);
  });

  it('toggles the two state classes and is a no-op on a missing element', () => {
    const host = document.createElement('div');

    setVerdictHtml(host, verdictHtml('audio'), true);
    expect(host.classList.contains('text-error')).toBe(true);

    setVerdictHtml(host, verdictHtml('audio'), false);
    expect(host.classList.contains('text-on-surface-variant')).toBe(true);

    expect(() => setVerdictHtml(null, verdictHtml('audio'))).not.toThrow();
  });
});

/* ── عقد مواضع النداء ────────────────────────────────────────────────────
 * المصرف الغني مسموح فقط بوسم verdictHtml(). الاختبار يقرأ المصادر نفسها:
 * أي نداء جديد يمرّر شيئاً آخر (نصّ خلفية، رسالة خطأ، مسار ملف) يسقط هنا. */
const SINK_CALL_FILES: ReadonlyArray<readonly [string, string]> = [
  ['src/main.ts', mainSource],
  ['src/media.ts', mediaSource],
  ['src/queue.ts', queueSource],
];
const EXPECTED_CALL_SITES = 3; // main.ts:148 · media.ts:116 · queue.ts:49

/** Lines that really call setVerdictHtml — block comments stripped, line
 *  comments and the declaration itself skipped. */
function sinkCallLines(file: string, source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return code
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      const at = line.indexOf('setVerdictHtml(');
      if (at < 0) return false;
      if (line.slice(0, at).includes('function ')) return false; // the declaration
      const before = line.slice(0, at);
      if (/\/\/[^'"]*$/.test(before)) return false; // inside a line comment
      return true;
    })
    .map(({ line, no }) => `${file}:${no} ${line.trim()}`);
}

describe('د-٩ · every setVerdictHtml call site feeds it verdictHtml() only', () => {
  it('finds the call sites at all (guards against a vacuous scan)', () => {
    const found = SINK_CALL_FILES.flatMap(([file, src]) => sinkCallLines(file, src));
    expect(found).toHaveLength(EXPECTED_CALL_SITES);
  });

  it('passes verdictHtml(…) as the second argument of every call', () => {
    const offenders = SINK_CALL_FILES.flatMap(([file, src]) => sinkCallLines(file, src)).filter(
      (line) => !/setVerdictHtml\(\s*[^,]+,\s*verdictHtml\(/.test(line),
    );
    expect(offenders, 'HTML sink fed with something other than static verdictHtml()').toEqual([]);
  });
});
