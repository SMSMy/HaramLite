/* ── ن-٣ · المزوّد الفعّال في الواجهة: ثلاثة أحوال لا اثنان ───────────────────
 *
 * **القاعدة التي يحرسها هذا الملف**: لا يُعرض «CPU» ولا أي اسم مزوّد لم يُقَس.
 * `provider.json` يُكتب في كل جلسة فصل، وغيابه يعني **لم تُجرَّ جلسة بعد** —
 * وهي حالة ثالثة غير «CUDA» وغير «CPU». فالعقد الذي يبنيه الرست
 * (`cuda_status_payload`) يحمل `provider` و`provider_known`، وهذا الملف يقيس
 * ما تفعله الواجهة بكل تركيب ممكن — بما فيه تركيب **متناقض** (معرفة مؤكَّدة
 * واسم غائب) وتركيب **تالف** (اسم بمسافات أو رقم) — لأن الثقة بالخلف وحدها
 * ليست حارساً على الشاشة.
 *
 * **والمُفسَدات هنا ليست زينة**: كل حالة موسومة «مُفسَد» كانت ستُعرض خطأً لو
 * أُسقط شرط منها (مثلاً: `provider ?? 'CPU'`، أو `known = !!st.provider`). وكل
 * ضابط يقابلها يثبت أن الحارس لا يمرّ لأنه لا ينظر.
 *
 * **ما لا يقيسه** (بصراحة): لا Rust ولا Tauri — `invoke` وهمي، فالمقاس هو
 * طبقة العرض وحدها. عقد الرست نفسه مقيس في `cuda_runtime.rs`/`lib.rs`
 * (`cuda_status_payload_reports_unknown_without_claiming_cpu`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import { i18n, t } from '../i18n';

const h = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => null),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));

import { providerLine, refreshProviderLine } from '../cuda';

const AR = i18n.ar as unknown as Record<string, string>;

function mount(): void {
  const doc = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');
  document.body.innerHTML = doc.body.innerHTML;
}

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockImplementation(async () => null);
  mount();
});

describe('ن-٣ · providerLine: نصّ الحالة وحكمها', () => {
  it('ضابط: مزوّد معروف يُعرض باسمه وبلا تحذير', () => {
    const cu = providerLine({ provider: 'CUDA', provider_known: true });
    expect(cu.warn).toBe(false);
    expect(cu.text).toBe(t('cuda_provider_label', { name: 'CUDA' }));
    expect(cu.text).toContain('CUDA');

    const dml = providerLine({ provider: 'DirectML', provider_known: true });
    expect(dml.warn).toBe(false);
    expect(dml.text).toContain('DirectML');
  });

  it('ضابط: السقوط إلى CPU يُعلَن بتحذير صريح لا بسطر عادي', () => {
    const cpu = providerLine({ provider: 'CPU', provider_known: true });
    expect(cpu.warn).toBe(true);
    expect(cpu.text).toContain('CPU');
    expect(cpu.text).toBe(t('cuda_provider_cpu_warn'));
  });

  it('مُفسَد: غياب المعرفة لا يُترجَم إلى «CPU»', () => {
    for (const st of [
      { provider: null, provider_known: false },
      { provider: 'CUDA', provider_known: false },
      null,
    ]) {
      const line = providerLine(st);
      expect(line.warn).toBe(false);
      expect(line.text).toBe(t('cuda_provider_unknown'));
      expect(line.text).not.toContain('CPU');
      expect(line.text).not.toContain('CUDA');
      expect(line.text).not.toContain('DirectML');
    }
  });

  it('مُفسَد: عقد متناقض (provider_known=true وprovider=null) ⇒ غير معروف', () => {
    const line = providerLine({ provider: null, provider_known: true });
    expect(line.text).toBe(t('cuda_provider_unknown'));
    expect(line.warn).toBe(false);
    expect(line.text).not.toContain('CPU');
  });

  it('مُفسَد: اسم مزوّد فارغ أو مسافات ⇒ غير معروف لا اسم مبتور', () => {
    for (const provider of ['', '   ', '\t']) {
      const line = providerLine({ provider, provider_known: true });
      expect(line.text).toBe(t('cuda_provider_unknown'));
      expect(line.warn).toBe(false);
    }
  });

  it('مُفسَد: اسم مزوّد غير نصّي (رقم من ملف تالف) ⇒ غير معروف', () => {
    const line = providerLine({ provider: 3 as unknown as string, provider_known: true });
    expect(line.text).toBe(t('cuda_provider_unknown'));
  });

  it('الاسم يُقصّ قبل العرض (ملف كُتب بمسافات) و«cpu» بحروف صغيرة تُعرَف', () => {
    expect(providerLine({ provider: '  DirectML  ', provider_known: true }).text).toContain(
      'DirectML',
    );
    expect(providerLine({ provider: 'cpu', provider_known: true }).warn).toBe(true);
  });
});

describe('ن-٣ · refreshProviderLine: الربط الحقيقي بالعنصر', () => {
  it('يكتب نصّ الخلف على #cuda-provider ويضبط صنف التحذير عند CPU', async () => {
    h.invoke.mockResolvedValueOnce({
      nvidia: true,
      cuda: false,
      provider: 'CPU',
      provider_known: true,
    });
    await refreshProviderLine();
    const el = document.getElementById('cuda-provider');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe(t('cuda_provider_cpu_warn'));
    expect(el?.classList.contains('text-error')).toBe(true);
    expect(el?.classList.contains('text-on-surface-variant')).toBe(false);

    h.invoke.mockResolvedValueOnce({
      nvidia: true,
      cuda: true,
      provider: 'DirectML',
      provider_known: true,
    });
    await refreshProviderLine();
    expect(el?.textContent).toContain('DirectML');
    expect(el?.classList.contains('text-error')).toBe(false);
    expect(el?.classList.contains('text-on-surface-variant')).toBe(true);
  });

  it('مُفسَد: نداء فاشل لا يمحو الحالة ولا يخترع حالة جديدة', async () => {
    h.invoke.mockResolvedValueOnce({
      nvidia: true,
      cuda: false,
      provider: 'CPU',
      provider_known: true,
    });
    await refreshProviderLine();
    const el = document.getElementById('cuda-provider');
    expect(el?.textContent).toBe(t('cuda_provider_cpu_warn'));

    h.invoke.mockRejectedValueOnce(new Error('ipc down'));
    await refreshProviderLine();
    expect(el?.textContent).toBe(t('cuda_provider_cpu_warn'));
    expect(el?.classList.contains('text-error')).toBe(true);
  });

  it('الأمر المقيس هو cuda_status نفسه (لا أمر جديد)', async () => {
    h.invoke.mockResolvedValueOnce({
      nvidia: false,
      cuda: false,
      provider: null,
      provider_known: false,
    });
    await refreshProviderLine();
    expect(h.invoke).toHaveBeenCalledWith('cuda_status');
  });
});

describe('ن-٣ · السطح الافتراضي في index.html صادق قبل أي نداء', () => {
  it('العنصر مربوط بمفتاح «غير معروف» ونصّه الابتدائي هو نصّه العربي', () => {
    const doc = new DOMParser().parseFromString(indexHtml as unknown as string, 'text/html');
    const el = doc.getElementById('cuda-provider');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-i18n')).toBe('cuda_provider_unknown');
    expect((el?.textContent || '').trim()).toBe(AR.cuda_provider_unknown);
    expect(el?.textContent || '').not.toContain('CPU');
  });

  it('مفاتيح ن-٣ الثلاثة موجودة في اللغتين بنفس المتغيّرات', () => {
    for (const k of ['cuda_provider_unknown', 'cuda_provider_label', 'cuda_provider_cpu_warn']) {
      expect(Object.keys(AR)).toContain(k);
      expect(Object.keys(i18n.en as unknown as Record<string, string>)).toContain(k);
    }
    const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(vars(AR.cuda_provider_label)).toEqual(['name']);
  });
});
