//! Sealing the two secrets that live in `settings.json` (the Telegram bot
//! token and the local-server api_hash) with Windows DPAPI.
//!
//! Why: a bot token is a key to the owner's machine — anyone holding it can
//! drive the bot. On disk it was plaintext, so it travelled with backups, with
//! cloud sync and with any file the owner shared while asking for support.
//! Sealed, none of those carry a usable secret, and a token scraper scanning
//! the disk finds nothing.
//!
//! Honest limits (stated, not implied): DPAPI protects against ANOTHER user on
//! the machine and against offline access to the file/copy. It does NOT protect
//! against malware running as the same user — that code can call
//! `CryptUnprotectData` exactly as we do. This is defence in depth, not a
//! security boundary.
//!
//! The value carries a version marker so "sealed" and "plaintext" are never
//! guessed: a Telegram token itself looks like `123456:AA…`, so any prefix
//! heuristic on the secret's own shape would be ambiguous (owner's plan review,
//! 2026-09-11).

/// Prefix that marks a sealed value. Anything else is treated as plaintext and
/// is sealed on the next save — migration is therefore idempotent.
pub const MARKER: &str = "dpapi:v1:";

pub fn is_sealed(value: &str) -> bool {
    value.starts_with(MARKER)
}

/// Seal a secret for storage. `None` when sealing is unavailable (non-Windows)
/// or failed — callers then keep the plaintext rather than losing the value.
pub fn seal(plain: &str) -> Option<String> {
    let bytes = dpapi(plain.as_bytes(), true)?;
    Some(format!("{MARKER}{}", to_hex(&bytes)))
}

/// Open a sealed value. `None` when the blob cannot be opened on THIS user +
/// machine (a settings.json copied from elsewhere, a re-installed Windows, a
/// password reset) — the caller treats that as "no secret" and says so, rather
/// than running with a broken credential.
pub fn unseal(value: &str) -> Option<String> {
    let hex = value.strip_prefix(MARKER)?;
    let bytes = from_hex(hex)?;
    let out = dpapi(&bytes, false)?;
    String::from_utf8(out).ok()
}

/// Storage form of a settings string: empty stays empty, an already-sealed
/// value is left alone, plaintext is sealed when possible.
pub fn seal_setting(value: &str) -> String {
    if value.is_empty() || is_sealed(value) {
        return value.to_string();
    }
    seal(value).unwrap_or_else(|| value.to_string())
}

/// In-memory form: sealed values are opened; plaintext passes through; an
/// unopenable blob becomes empty (never a half-broken credential).
pub fn open_setting(value: &str) -> String {
    if !is_sealed(value) {
        return value.to_string();
    }
    match unseal(value) {
        Some(v) => v,
        None => {
            tracing::warn!(
                target: "app",
                "قيمة مشفّرة في الإعدادات تعذر فكّها على هذا المستخدم/الجهاز — ستُعامل كغير مضبوطة"
            );
            String::new()
        }
    }
}

// ── tiny hex codec (no new dependency for a 40-byte blob) ───────────────────

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from(b"0123456789abcdef"[(b >> 4) as usize]));
        s.push(char::from(b"0123456789abcdef"[(b & 0x0f) as usize]));
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let val = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    for pair in b.chunks(2) {
        out.push((val(pair[0])? << 4) | val(pair[1])?);
    }
    Some(out)
}

// ── DPAPI ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // CRYPTPROTECT_UI_FORBIDDEN: never pop a dialog from a background worker.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &mut input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &mut input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
    };
    if ok == 0 || out.pbData.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe {
        LocalFree(out.pbData as *mut core::ffi::c_void);
    }
    Some(bytes)
}

#[cfg(not(target_os = "windows"))]
fn dpapi(_data: &[u8], _protect: bool) -> Option<Vec<u8>> {
    None // no DPAPI off-Windows; settings stay plaintext there (documented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_codec_round_trips_and_rejects_junk() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        assert_eq!(from_hex("0").is_none(), true, "odd length");
        assert_eq!(from_hex("zz").is_none(), true, "non-hex");
    }

    #[test]
    fn plaintext_is_recognised_and_empty_stays_empty() {
        assert!(!is_sealed("88360566:AAHsecret"));
        assert!(is_sealed("dpapi:v1:0011ff"));
        assert_eq!(seal_setting(""), "");
        assert_eq!(open_setting(""), "");
        // A plaintext value passes through `open_setting` untouched, so an
        // upgraded install keeps working before the first re-save.
        assert_eq!(open_setting("88360566:AAHsecret"), "88360566:AAHsecret");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_seals_and_opens_on_this_machine() {
        let secret = "88360566:AAH_test_token_value";
        let sealed = seal(secret).expect("DPAPI must be available on Windows");
        assert!(is_sealed(&sealed), "marker expected: {sealed}");
        assert!(!sealed.contains("AAH_test"), "plaintext must not survive sealing");
        assert_eq!(unseal(&sealed).as_deref(), Some(secret), "round-trip");
        // Sealing is deterministic in shape but not in bytes (DPAPI salts).
        assert_eq!(seal_setting(&sealed), sealed, "already sealed ⇒ untouched");
        assert_eq!(open_setting(&sealed), secret);
    }

    #[test]
    fn a_foreign_or_corrupt_blob_degrades_to_empty_never_to_garbage() {
        // Well-formed marker, junk payload: must not panic and must not pretend
        // it holds a usable secret.
        assert_eq!(open_setting("dpapi:v1:zzzz"), "");
        assert_eq!(open_setting("dpapi:v1:00"), "");
        assert_eq!(unseal("not-sealed-at-all"), None);
    }
}
