//! Wikilink 语法解析：把 `[[...]]` 切出 (target, alias, heading) 三元组，
//! 解析业务（重名解析、虚链、rename 重写等）留给上层。
//!
//! 5 种形式：
//! - `[[Note]]`
//! - `[[Note|Alias]]`
//! - `[[Note#Heading]]`
//! - `[[Folder/Note]]`
//! - `[[Folder/Note|Alias]]`
//!
//! 当前版本不裁决的行为边界：大小写敏感性、重名解析、rename 重写、虚链、
//! heading 锚归一——这些都让上层业务决定，解析层只切字段。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    /// 整体在原文本中的字节范围（左闭右开）
    pub span: (usize, usize),
    /// 第一个 "/" 之前的所有路径段（不含 "#heading"）
    pub target: String,
    /// 可选：`#heading` 部分（不带 #），全部小写存储
    pub heading: Option<String>,
    /// 可选：`|alias` 之后的显示文本
    pub alias: Option<String>,
}

/// 扫描整个 Markdown 文本，提取所有 wikilink。
/// 嵌套括号、外层已是 markdown 链接/代码的语境等边界，由调用方选择是否预过滤
/// （这里只做行级扫描）。
///
/// 边界规则（防止误报）：
/// - `\[` 视为转义，跳过下一个 `]`
/// - 必须成对：未闭合的 `[[` 不产出
/// - 不允许中间换行（`[[Note\n...]]` 不算）
/// - target 段不允许空：`-[[]]` 不产出
pub fn extract_links(text: &str) -> Vec<WikiLink> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        // 转义：跳过
        if bytes[i] == b'\\' && bytes[i + 1] == b'[' {
            i += 2;
            continue;
        }
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = find_link_end(bytes, i + 2) {
                let raw = &text[i + 2..end]; // "[[" 与 "]]" 之间的内容
                if let Some(link) = parse_link_content(i, end + 2, raw) {
                    out.push(link);
                }
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 把 `\[`、`\]`、`\\` 转义去掉。只在 raw 内做，不递归。
fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() && matches!(bytes[i + 1], b'[' | b']' | b'\\') {
            out.push(bytes[i + 1]);
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// 从 `[[` 之后的位置开始找匹配的 `]]`。要求闭合 `]]` 在同一行。
/// 返回 `]]` 中第二个 `]` 的索引。
fn find_link_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 1;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b']' {
            i += 2;
            continue;
        }
        if b == b'\n' || b == b'\r' {
            return None;
        }
        if b == b'[' {
            depth += 1;
        } else if b == b']' {
            depth -= 1;
            if depth == 0 && i + 1 < bytes.len() && bytes[i + 1] == b']' {
                return Some(i);
            }
            if depth < 0 {
                return None;
            }
        }
        i += 1;
    }
    None
}

/// 解析 `[[...]]` 内部内容为 (target, heading, alias)。
/// 形态：`Target[#Heading]` 或 `Target[#Heading]|Alias` 或 `Target|Alias` 或 `Target`。
/// target 段允许 `/` 路径分隔符（任何非空字符序列除 `|`/`#`/空白）。
fn parse_link_content(span_start: usize, span_end: usize, raw: &str) -> Option<WikiLink> {
    if raw.is_empty() || raw.contains('\n') || raw.contains('\r') {
        return None;
    }

    // 0) 把转义字符去掉（`\]` → `]`，`\\` → `\`，其它保持）
    let unescaped = unescape(raw);

    let mut target = unescaped.as_str();
    let mut heading = None;
    let mut alias = None;

    // 1) 切 alias：以首个 `|` 为界（target 段不允许 `|`，所以首位无歧义）
    if let Some(pipe) = unescaped.find('|') {
        let (t, a) = unescaped.split_at(pipe);
        target = t;
        alias = Some(a[1..].to_string());
        if alias.as_deref() == Some("") {
            // `[[Note|]]` 视同无 alias
            alias = None;
        }
    }

    // 2) 切 heading：以首个 `#` 为界（剩余段不允许 `#`，所以首位无歧义）
    if let Some(hash) = target.find('#') {
        let (t, h) = target.split_at(hash);
        if h.len() > 1 {
            heading = Some(h[1..].to_ascii_lowercase());
        }
        target = t;
    }

    // 3) target 段合法性：非空、不含 `|`/`#`/空白/`[`/反引号/反斜杠
    // 允许 `]`：转义序列 `\]` 在 unescape 阶段已剥成字面 `]`，target 应保留
    if target.is_empty() {
        return None;
    }
    if target
        .chars()
        .any(|c| matches!(c, '|' | '#' | ' ' | '\t' | '[' | '`' | '\\'))
    {
        return None;
    }
    // target 不能只含路径分隔符（`.` 和 `..` 也算无效但保留语义给上层裁决）
    // 这里只拒绝空 target 和连续斜杠
    if target.starts_with('/') || target.ends_with('/') {
        return None;
    }

    Some(WikiLink {
        span: (span_start, span_end),
        target: target.to_string(),
        heading,
        alias,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(text: &str) -> Vec<(String, Option<String>, Option<String>)> {
        extract_links(text)
            .into_iter()
            .map(|l| (l.target, l.heading, l.alias))
            .collect()
    }

    #[test]
    fn five_forms() {
        assert_eq!(
            links("[[Note]]"),
            vec![("Note".into(), None, None)]
        );
        assert_eq!(
            links("[[Note|Alias]]"),
            vec![("Note".into(), None, Some("Alias".into()))]
        );
        assert_eq!(
            links("[[Note#Heading]]"),
            vec![("Note".into(), Some("heading".into()), None)]
        );
        assert_eq!(
            links("[[Folder/Note]]"),
            vec![("Folder/Note".into(), None, None)]
        );
        assert_eq!(
            links("[[Folder/Note|Alias]]"),
            vec![("Folder/Note".into(), None, Some("Alias".into()))]
        );
    }

    #[test]
    fn alias_with_heading() {
        assert_eq!(
            links("[[Folder/Note#Sec|Alias]]"),
            vec![("Folder/Note".into(), Some("sec".into()), Some("Alias".into()))]
        );
    }

    #[test]
    fn heading_normalized_to_lowercase() {
        assert_eq!(
            links("[[Note#MySection]]"),
            vec![("Note".into(), Some("mysection".into()), None)]
        );
    }

    #[test]
    fn multiple_in_one_line() {
        assert_eq!(
            links("see [[A]] and [[B|alias]]"),
            vec![
                ("A".into(), None, None),
                ("B".into(), None, Some("alias".into())),
            ]
        );
    }

    #[test]
    fn ignores_escaped_brackets() {
        // \[[ 不是 wikilink；行内第一个 ] 是关闭，不算
        assert!(links(r"text \[[Not a link]]").is_empty());
        // wikilink 内部转义 `]` 允许（反斜杠被吞掉不算 target 字符）
        assert_eq!(
            links(r"[[A\]B]]"),
            vec![(r"A]B".into(), None, None)]
        );
    }

    #[test]
    fn rejects_empty_target() {
        assert!(links("[[]]").is_empty());
        assert!(links("[[|alias]]").is_empty());
        assert!(links("[[#h]]").is_empty());
    }

    #[test]
    fn rejects_unclosed_and_unbalanced() {
        assert!(links("[[unclosed").is_empty());
        assert!(links("[[a]b]]").is_empty()); // 不平衡括号
        assert!(links("[[a\nb]]").is_empty()); // 换行
    }

    #[test]
    fn rejects_trailing_slashes() {
        assert!(links("[[/foo]]").is_empty());
        assert!(links("[[foo/]]").is_empty());
        assert!(links("[[]]").is_empty());
    }

    #[test]
    fn span_is_byte_accurate() {
        let text = "before [[Target]] after";
        let link = &extract_links(text)[0];
        assert_eq!(&text[link.span.0..link.span.1], "[[Target]]");
    }

    #[test]
    fn preserves_chinese_and_punctuation_in_target() {
        // wikilink 语法本身没有限制字符集：target 可以是除控制字符外的任意字符
        // （中文、文件夹斜杠、拉丁字母、括号都可以；空格会断开 wikilink 所以要避开）
        assert_eq!(
            links("[[论文精读/Attention-(Self)]]"),
            vec![("论文精读/Attention-(Self)".into(), None, None)]
        );
    }

    #[test]
    fn non_markdown_brackets_ignored() {
        // 单层 [..] 不是 wikilink
        assert!(links("normal [link](http://x) here").is_empty());
        // 三层 [[..]..] 不产出
        assert!(links("[[A]B]]").is_empty());
    }
}