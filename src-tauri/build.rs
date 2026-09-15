use std::path::Path;

/// يستخرج قيمة سمة من نص المانيفست: `name="value"` — بحث نصي بلا تبعيات.
fn manifest_attr(manifest: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = manifest.find(&key)? + key.len();
    let rest = &manifest[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Audit 2026-09-15 (٨): إزالة لغم يمنع `cargo test` من العمل أصلاً.
///
/// العطل: أي اختبار يستدعي `watch_service::apply_settings` يجعل `run_watch` →
/// الـpipeline → `rfd` قابلاً للوصول من **ثنائي اختبار المكتبة**، فيُصدَّر
/// `comctl32!TaskDialogIndirect` في جدول استيراده. وبلا مانيفست يطلب comctl32
/// **v6** يحصل الثنائي على النسخة v5 الافتراضية (لا تحتوي `TaskDialogIndirect`)
/// ⇒ يفشل **التحميل** بـ STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) ويسقط
/// `cargo test` كله، لا اختبار واحد.
///
/// لماذا لا `cargo::rustc-link-arg-tests` كما اقترح المراجع: على cargo 1.95
/// تُرفض هذه التعليمات إن لم يكن للحزمة هدف `[[test]]` («invalid instruction …
/// does not have a test target»)، وهي **لا تشمل** ثنائي اختبار المكتبة أصلاً —
/// قِيست: الوسم يصل إلى `tests/*.rs` وحده، والوسم العام `rustc-link-arg` يصل
/// إلى ثنائي اختبار المكتبة **وإلى bins** معاً، وbins تحمل مانيفست tauri-build
/// عبر `rustc-link-arg-bins` ⇒ تمرير `/MANIFEST:EMBED` عامّاً يقتل بناء الإنتاج:
/// `CVTRES: fatal error CVT1100: duplicate resource. type:MANIFEST, name:1`
/// (مُثبت بالتجربة). فلا مسار لوماً يخصّ ثنائي اختبار المكتبة وحده.
///
/// الحل: tauri-build يولّد في OUT_DIR مكتبة موارد `resource.lib` تحمل مانيفست
/// comctl32 v6 نفسه (مُتحقَّق منه أدناه مقابل `test-comctl32.manifest`)، لكنه
/// يربطها بـ bins وحدها. فنُهيّئ هنا مسار بحث أصلياً يحتوي نسخة منها، ويربطها
/// ثنائي اختبار المكتبة وحده عبر `#[cfg(test)] #[link(...)]` في `lib.rs` —
/// فالإنتاج وbins لا يتغيّران بحرف.
fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let resource = Path::new(&out_dir).join("resource.lib");
    if !resource.is_file() {
        println!(
            "cargo::warning=tauri-build لم يولّد resource.lib — ثنائي اختبار المكتبة لن يحمل مانيفست comctl32 v6 وسيفشل بالتحميل إن لمس اختبارٌ مسار المراقبة"
        );
        return;
    }

    // الشرط الذي يجعل الحل صحيحاً: المكتبة يجب أن تحمل فعلاً هوية comctl32 v6
    // المعلنة في `test-comctl32.manifest` (نصّها ASCII داخل المكتبة).
    let declared = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("test-comctl32.manifest"))
        .unwrap_or_default();
    let lib_text = String::from_utf8_lossy(&std::fs::read(&resource).unwrap_or_default()).into_owned();
    for attr in ["name", "version", "publicKeyToken"] {
        match manifest_attr(&declared, attr) {
            Some(v) if lib_text.contains(&v) => {}
            Some(v) => println!(
                "cargo::warning=resource.lib لا يحمل {attr}=\"{v}\" من test-comctl32.manifest — ثنائي اختبار المكتبة قد يفشل بالتحميل (0xc0000139)"
            ),
            None => {}
        }
    }

    // مسار بحث خاص بالاختبارات: نسخة من المكتبة وحدها، فلا يتعرّض مسار البحث
    // الأصلي لكل ما في OUT_DIR.
    let dir = Path::new(&out_dir).join("test-manifest");
    if std::fs::create_dir_all(&dir).is_err() || std::fs::copy(&resource, dir.join("resource.lib")).is_err() {
        println!("cargo::warning=تعذّر تجهيز نسخة resource.lib لثنائي الاختبار");
        return;
    }
    println!("cargo::rustc-link-search=native={}", dir.display());
}
