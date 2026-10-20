//! WebNovel Ultimate Chapter Copier: text engine.
//!
//! The text logic lives in the `text` module so it can be unit tested natively
//! with `cargo test`. The `#[wasm_bindgen]` functions at the bottom are thin
//! wrappers that expose the same logic to JavaScript. The engine never touches
//! the DOM, the network, or the clipboard.

use wasm_bindgen::prelude::*;

pub mod text {
    /// Minimum number of non-whitespace characters for a chapter to be valid.
    pub const MIN_CHAPTER_CHARS: usize = 100;

    /// Statistics computed on the normalized text.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct TextStats {
        pub characters: usize,
        pub paragraphs: usize,
        pub non_whitespace: usize,
        pub normalized: String,
    }

    /// Whitespace trimmed from the start and end of each line. U+3000 (ideographic
    /// space) is included because many Chinese novels use it for paragraph indents.
    fn is_edge_space(c: char) -> bool {
        matches!(c, ' ' | '\t' | '\u{00A0}' | '\u{3000}' | '\u{2007}' | '\u{202F}')
    }

    /// Runs of these characters inside a line collapse to one ASCII space.
    /// U+3000 is excluded so intentional ideographic spacing is preserved.
    fn is_collapsible(c: char) -> bool {
        matches!(c, ' ' | '\t' | '\u{00A0}' | '\u{2007}' | '\u{202F}')
    }

    /// Invisible characters with no visible content: zero-width space and BOM.
    /// ZWJ (U+200D) is kept because it joins emoji sequences.
    fn is_invisible(c: char) -> bool {
        matches!(c, '\u{200B}' | '\u{FEFF}')
    }

    fn normalize_line(line: &str) -> String {
        let trimmed = line.trim_matches(is_edge_space);
        let mut out = String::with_capacity(trimmed.len());
        let mut in_run = false;
        for c in trimmed.chars() {
            if is_collapsible(c) {
                if !in_run {
                    out.push(' ');
                    in_run = true;
                }
            } else {
                out.push(c);
                in_run = false;
            }
        }
        out
    }

    /// Normalizes chapter text while preserving wording, punctuation, Unicode,
    /// paragraph order, and meaningful blank lines.
    ///
    /// - CRLF and CR become LF.
    /// - Zero-width spaces and BOMs are removed.
    /// - Leading and trailing spaces on each line are removed.
    /// - Runs of ordinary spaces inside a line collapse to one space.
    /// - Consecutive blank lines collapse to a single blank line.
    /// - Leading and trailing blank lines are removed.
    /// Repeated paragraphs are never removed.
    pub fn normalize(input: &str) -> String {
        let unified = input.replace("\r\n", "\n").replace('\r', "\n");
        let mut blocks: Vec<String> = Vec::new();
        let mut pending_blank = false;

        for raw in unified.split('\n') {
            let visible: String = raw.chars().filter(|c| !is_invisible(*c)).collect();
            let line = normalize_line(&visible);
            if line.is_empty() {
                if !blocks.is_empty() {
                    pending_blank = true;
                }
            } else {
                if pending_blank {
                    blocks.push(String::new());
                    pending_blank = false;
                }
                blocks.push(line);
            }
        }
        blocks.join("\n")
    }

    /// Number of Unicode scalar values in the normalized text.
    pub fn count_characters(input: &str) -> usize {
        normalize(input).chars().count()
    }

    /// Number of non-empty lines in the normalized text.
    pub fn count_paragraphs(input: &str) -> usize {
        normalize(input).split('\n').filter(|line| !line.is_empty()).count()
    }

    /// Computes all statistics from a single normalization pass.
    pub fn statistics(input: &str) -> TextStats {
        let normalized = normalize(input);
        let characters = normalized.chars().count();
        let paragraphs = normalized.split('\n').filter(|line| !line.is_empty()).count();
        let non_whitespace = normalized.chars().filter(|c| !c.is_whitespace()).count();
        TextStats {
            characters,
            paragraphs,
            non_whitespace,
            normalized,
        }
    }

    /// A chapter is valid when it has at least `MIN_CHAPTER_CHARS` visible characters.
    /// Empty, whitespace-only, and clearly truncated extractions are rejected.
    pub fn validate(input: &str) -> bool {
        statistics(input).non_whitespace >= MIN_CHAPTER_CHARS
    }
}

// ---------------------------------------------------------------------------
// JavaScript bindings
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn normalize_chapter_text(input: &str) -> String {
    text::normalize(input)
}

#[wasm_bindgen]
pub fn count_characters(input: &str) -> usize {
    text::count_characters(input)
}

#[wasm_bindgen]
pub fn count_paragraphs(input: &str) -> usize {
    text::count_paragraphs(input)
}

#[wasm_bindgen]
pub fn validate_chapter_text(input: &str) -> bool {
    text::validate(input)
}

fn set_prop(obj: &js_sys::Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), &value).map(|_| ())
}

/// Returns `{ characters, paragraphs, non_whitespace, normalized }`.
#[wasm_bindgen]
pub fn get_text_statistics(input: &str) -> Result<JsValue, JsValue> {
    let stats = text::statistics(input);
    let obj = js_sys::Object::new();
    set_prop(&obj, "characters", JsValue::from_f64(stats.characters as f64))?;
    set_prop(&obj, "paragraphs", JsValue::from_f64(stats.paragraphs as f64))?;
    set_prop(&obj, "non_whitespace", JsValue::from_f64(stats.non_whitespace as f64))?;
    set_prop(&obj, "normalized", JsValue::from_str(&stats.normalized))?;
    Ok(obj.into())
}

// ---------------------------------------------------------------------------
// Unit tests (run with `cargo test` inside rust-engine/)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::text::*;

    #[test]
    fn empty_string_stays_empty() {
        assert_eq!(normalize(""), "");
        assert_eq!(count_characters(""), 0);
        assert_eq!(count_paragraphs(""), 0);
        assert!(!validate(""));
    }

    #[test]
    fn whitespace_only_is_empty() {
        assert_eq!(normalize("   \n\t \n"), "");
        assert_eq!(count_paragraphs("   \n\t \n"), 0);
        assert!(!validate("   \n\t \n"));
    }

    #[test]
    fn multiple_paragraphs_keep_their_blank_line() {
        let input = "第一段。\n\n第二段！";
        assert_eq!(normalize(input), input);
        assert_eq!(count_paragraphs(input), 2);
    }

    #[test]
    fn crlf_and_cr_become_lf() {
        assert_eq!(normalize("A\r\n\r\nB"), "A\n\nB");
        assert_eq!(normalize("A\rB"), "A\nB");
    }

    #[test]
    fn runs_of_blank_lines_collapse_to_one() {
        assert_eq!(normalize("A\n\n\n\nB"), "A\n\nB");
    }

    #[test]
    fn leading_and_trailing_blank_lines_are_removed() {
        assert_eq!(normalize("\n\n  Hello  \n\n"), "Hello");
    }

    #[test]
    fn non_breaking_spaces_collapse_to_one_space() {
        assert_eq!(normalize("a\u{00A0}\u{00A0}b"), "a b");
    }

    #[test]
    fn ideographic_indent_is_removed_at_line_start() {
        assert_eq!(normalize("\u{3000}\u{3000}他说：“你好。”"), "他说：“你好。”");
    }

    #[test]
    fn ideographic_space_inside_a_line_is_preserved() {
        assert_eq!(normalize("内 部\u{3000}空格"), "内 部\u{3000}空格");
    }

    #[test]
    fn zero_width_space_and_bom_are_removed() {
        assert_eq!(normalize("zero\u{200B}width\u{FEFF}"), "zerowidth");
    }

    #[test]
    fn zero_width_joiner_is_preserved_for_emoji() {
        let emoji = "👨\u{200D}👩";
        assert_eq!(normalize(emoji), emoji);
    }

    #[test]
    fn punctuation_and_dialogue_are_unchanged() {
        let input = "“Hi,” she said—“wait…”";
        assert_eq!(normalize(input), input);
    }

    #[test]
    fn repeated_paragraphs_are_never_removed() {
        let input = "Yes.\n\nYes.\n\nYes.";
        assert_eq!(normalize(input), input);
        assert_eq!(count_paragraphs(input), 3);
    }

    #[test]
    fn character_counts_include_spaces_and_code_points() {
        assert_eq!(count_characters("你好 世界"), 5);
        assert_eq!(count_characters("👨\u{200D}👩"), 3);
    }

    #[test]
    fn paragraph_counts_ignore_blank_lines() {
        assert_eq!(count_paragraphs("第一段\n\n第二段\n第三段"), 3);
    }

    #[test]
    fn statistics_are_computed_on_normalized_text() {
        let stats = statistics("a b\n\nc");
        assert_eq!(stats.characters, 6);
        assert_eq!(stats.paragraphs, 2);
        assert_eq!(stats.non_whitespace, 3);
        assert_eq!(stats.normalized, "a b\n\nc");
    }

    #[test]
    fn validation_requires_minimum_visible_characters() {
        assert!(!validate(&"a".repeat(99)));
        assert!(validate(&"a".repeat(100)));
        assert!(validate(&"汉".repeat(100)));
    }

    #[test]
    fn spaces_do_not_count_toward_validation() {
        assert!(!validate(&"a ".repeat(50)));
    }

    #[test]
    fn very_long_text_is_processed_completely() {
        let block = "段落测试。\n\n";
        let input = block.repeat(20_000);
        let stats = statistics(&input);
        assert_eq!(stats.paragraphs, 20_000);
        // 20,000 blocks of 5 characters, plus 19,999 blank-line separators of 2 characters.
        assert_eq!(stats.characters, 20_000 * 5 + 19_999 * 2);
        assert!(stats.normalized.ends_with("段落测试。"));
        assert!(validate(&input));
    }
}
