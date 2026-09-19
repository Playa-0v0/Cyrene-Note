//! 内容 hash：SHA-256 over raw disk bytes。
//!
//! 与 Cyrene-Agent 的 contentHash()（fs.readFile utf8 → sha256）逐字节等价，
//! 已对源码验证（契约 §3.2）。hash 是版本变更的最终事实。

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContentHash(pub String);

impl ContentHash {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let digest = Sha256::digest(bytes);
        Self(hex(&digest))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ContentHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_of_raw_bytes() {
        // sha256("# A\n") 的已知值，锚定实现正确性（printf '# A\n' | sha256sum）
        let h = ContentHash::from_bytes(b"# A\n");
        assert_eq!(
            h.as_str(),
            "aa1237b773c38dbddef583c4868aaea7a44c5237ea7923aecca5513764b42d80"
        );
    }

    #[test]
    fn crlf_and_lf_hash_differently() {
        // 契约 §3.2：hash 对原始字节计算，CRLF/LF 必须不同
        assert_ne!(
            ContentHash::from_bytes(b"# A\r\n"),
            ContentHash::from_bytes(b"# A\n")
        );
    }

    #[test]
    fn bom_changes_hash() {
        assert_ne!(
            ContentHash::from_bytes("\u{feff}# A\n".as_bytes()),
            ContentHash::from_bytes(b"# A\n")
        );
    }
}
