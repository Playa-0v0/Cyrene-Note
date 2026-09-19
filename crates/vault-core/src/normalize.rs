//! 归一化管线（契约 §3.5 加载路径）：
//!
//! raw bytes → UTF-8 校验 → BOM 检测 → CRLF/CR → LF → 编辑器内容
//!
//! 关键纪律：hash 永远在归一化**之前**的原始字节上计算；
//! 归一化只影响编辑器看到的内容，不影响与 Cyrene 的一致性判断。

use crate::error::{VaultError, VaultResult};

/// 加载结果：原始字节 hash + 归一化后内容 + 格式违规报告。
#[derive(Debug, Clone)]
pub struct LoadedNote {
    /// 原始磁盘字节的 SHA-256（与 Cyrene 逐字节一致）
    pub disk_hash: crate::ContentHash,
    /// 归一化后的编辑器内容（LF、无 BOM）
    pub content: String,
    /// 格式违规（不阻塞加载，UI 提示；重写保存时自然修复）
    pub violations: Vec<FormatViolation>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FormatViolation {
    Bom,
    CrlfLineEndings,
    CrLineEndings,
}

/// 加载管线：bytes 进，归一化内容出。hash 先行，任何变换不碰它。
pub fn load(bytes: &[u8], display_path: &str) -> VaultResult<LoadedNote> {
    let disk_hash = crate::ContentHash::from_bytes(bytes);

    // BOM 检测（记录违规但剥离后继续，避免首行标题失效）
    let (bytes, bom) = match bytes.strip_prefix("\u{feff}".as_bytes()) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };

    // UTF-8 严格校验：非法字节直接报错，绝不静默替换
    // （Node 侧会把非法字节替换为 U+FFFD，导致双方 hash 不一致——所以这里必须挡住）
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return Err(VaultError::InvalidEncoding(display_path.to_string())),
    };

    let mut violations = Vec::new();
    if bom {
        violations.push(FormatViolation::Bom);
    }
    if text.contains('\r') {
        if text.contains("\r\n") {
            violations.push(FormatViolation::CrlfLineEndings);
        } else {
            violations.push(FormatViolation::CrLineEndings);
        }
    }

    let content = normalize_lf(text);

    Ok(LoadedNote {
        disk_hash,
        content,
        violations,
    })
}

/// CRLF / 裸 CR → LF。
pub fn normalize_lf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// 保存前编码：内容必须是 LF、UTF-8 无 BOM。
/// 返回将要落盘的字节（磁盘格式由本函数统一保证）。
pub fn encode_for_disk(content: &str) -> Vec<u8> {
    // 内容在编辑器侧已是 LF；这里防御性再归一一次，成本可忽略
    let normalized = normalize_lf(content);
    normalized.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_lf_file_has_no_violations() {
        let r = load(b"# A\n\nbody\n", "a.md").unwrap();
        assert!(r.violations.is_empty());
        assert_eq!(r.content, "# A\n\nbody\n");
    }

    #[test]
    fn hash_computed_before_normalization() {
        // CRLF 文件：disk_hash 是 CRLF 字节的 hash，content 是 LF
        let r = load(b"# A\r\n", "a.md").unwrap();
        assert_eq!(r.disk_hash, crate::ContentHash::from_bytes(b"# A\r\n"));
        assert_eq!(r.content, "# A\n");
        assert_eq!(r.violations, vec![FormatViolation::CrlfLineEndings]);
    }

    #[test]
    fn bom_stripped_and_reported() {
        let r = load("\u{feff}# A\n".as_bytes(), "a.md").unwrap();
        assert!(r.violations.contains(&FormatViolation::Bom));
        assert_eq!(r.content, "# A\n");
        // hash 含 BOM（原始字节）
        assert_eq!(
            r.disk_hash,
            crate::ContentHash::from_bytes("\u{feff}# A\n".as_bytes())
        );
    }

    #[test]
    fn bare_cr_normalized() {
        let r = load(b"a\rb\rc", "a.md").unwrap();
        assert_eq!(r.content, "a\nb\nc");
        assert_eq!(r.violations, vec![FormatViolation::CrLineEndings]);
    }

    #[test]
    fn invalid_utf8_rejected_not_replaced() {
        assert!(matches!(
            load(&[0x23, 0x20, 0xff, 0xfe], "a.md"),
            Err(VaultError::InvalidEncoding(_))
        ));
    }

    #[test]
    fn encode_for_disk_is_lf_utf8_no_bom() {
        let bytes = encode_for_disk("# A\n");
        assert_eq!(bytes, b"# A\n");
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        // CRLF 防御性归一
        assert_eq!(encode_for_disk("a\r\nb"), b"a\nb");
    }
}
