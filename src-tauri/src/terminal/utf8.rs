//! Incremental UTF-8 decoding for a byte stream read in arbitrary chunks.
//!
//! A pseudo-terminal hands back whatever the child wrote, cut wherever the
//! read happened to stop — and a read of 8 KiB lands in the middle of a
//! multi-byte character often enough to matter (any accented name in a
//! document, every box-drawing glyph in a prompt). Decoding each chunk on its
//! own with `from_utf8_lossy` would turn that boundary into two U+FFFD
//! replacement characters on screen. So the incomplete tail of one chunk is
//! held back and prepended to the next; only bytes that can never become valid
//! UTF-8 are replaced.

/// Carries an incomplete trailing sequence (at most three bytes) from one
/// chunk to the next.
#[derive(Debug, Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    /// Decode `chunk`, prefixed by whatever the previous call held back.
    /// Returns everything that is complete; an incomplete tail waits for the
    /// next call.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);

        let mut out = String::with_capacity(bytes.len());
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    // Cannot fail: `valid_up_to` is exactly the valid prefix.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        // Bytes that are wrong whatever follows: replace them
                        // and keep decoding after them.
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[bad..];
                        }
                        // A sequence cut short by the end of the chunk: hold
                        // it back for the next one.
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// The stream ended: whatever was held back can no longer complete.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            char::REPLACEMENT_CHARACTER.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Stream;

    #[test]
    fn ascii_passes_straight_through() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"test> "), "test> ");
        assert_eq!(s.finish(), "");
    }

    #[test]
    fn a_character_split_across_two_reads_is_decoded_whole() {
        let bytes = "año ✓".as_bytes();
        // `ñ` is two bytes, `✓` three: cut inside each of them.
        let cut_n = 2; // after 'a' and the first byte of 'ñ'
        let mut s = Utf8Stream::default();
        let mut out = s.push(&bytes[..cut_n]);
        assert_eq!(out, "a", "the half character waits");
        let cut_check = bytes.len() - 1;
        out.push_str(&s.push(&bytes[cut_n..cut_check]));
        out.push_str(&s.push(&bytes[cut_check..]));
        assert_eq!(out, "año ✓");
        assert_eq!(s.finish(), "");
    }

    #[test]
    fn a_character_fed_one_byte_at_a_time_still_arrives_once() {
        let mut s = Utf8Stream::default();
        let out: String = "€".bytes().map(|b| s.push(&[b])).collect();
        assert_eq!(out, "€");
    }

    #[test]
    fn invalid_bytes_are_replaced_and_decoding_carries_on() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"ok\xFFstill ok"), "ok\u{FFFD}still ok");
    }

    #[test]
    fn a_stream_that_ends_mid_character_reports_one_replacement() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(&"✓".as_bytes()[..2]), "");
        assert_eq!(s.finish(), "\u{FFFD}");
        assert_eq!(s.finish(), "", "finish is idempotent");
    }
}
