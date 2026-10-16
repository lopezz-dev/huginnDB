//! Answering one question a child asks at startup, before the user sees it.
//!
//! The case it exists for: `mongosh` on Windows asks for a connection string
//! when it believes it was started by a double-click — no connection string
//! given, a TTY on both ends, and **only one process on its console**. Inside
//! a ConPTY it is always the only process on its console, so it asks every
//! time, and it does so whatever else is on its command line: `--nodb` is not
//! part of the check. An empty answer is the documented way past it ("Default:
//! mongodb://localhost/" is only applied to a non-empty one), after which the
//! `--nodb --eval` bootstrap runs as it does everywhere else.
//!
//! The prompt cannot be avoided from the command line: under `--nodb` every
//! positional argument is a script to run, not a connection string, and the
//! real connection string is never put on the command line (see
//! `mongosh.rs`). So the session answers it, and keeps it off the screen.
//!
//! [`Answerer`] is the pure half: it sees the output stream, holds back
//! anything that could still turn out to be the prompt, removes the prompt
//! when it arrives and says when to send the reply. Text that cannot be part
//! of the prompt is passed on at once, so a child that never asks — another
//! platform, a later `mongosh` that fixes the check — is not delayed at all.

/// One question to answer: the exact text the child prints, and what to type.
#[derive(Debug, Clone, Copy)]
pub struct Answer {
    pub prompt: &'static str,
    pub reply: &'static str,
}

/// After this much output without the prompt, stop watching for it: the
/// question is asked before anything else the child prints, never later.
const WATCH_LIMIT: usize = 8 * 1024;

#[derive(Debug)]
enum State {
    Watching {
        seen: usize,
    },
    /// Answered; the terminal is about to echo the reply's Enter, which would
    /// leave a blank line where the hidden prompt was.
    SwallowEcho,
    Done,
}

/// What to do with one chunk of output.
#[derive(Debug, Default, PartialEq)]
pub struct Step {
    /// Show this. May be empty while a possible prompt is held back.
    pub emit: String,
    /// Send the reply to the child now.
    pub reply: bool,
}

#[derive(Debug)]
pub struct Answerer {
    prompt: &'static str,
    held: String,
    state: State,
}

impl Answerer {
    pub fn new(answer: &Answer) -> Self {
        Self {
            // Matched without its trailing spaces: ConPTY renders a line by
            // trimming them and erasing to the end of line instead (`ESC[K`),
            // so "string: " arrives as "string:\x1b[K". Whatever spaces do
            // arrive after it are dropped along with it.
            prompt: answer.prompt.trim_end(),
            held: String::new(),
            state: State::Watching { seen: 0 },
        }
    }

    pub fn push(&mut self, text: &str) -> Step {
        match self.state {
            State::Done => Step {
                emit: text.to_string(),
                reply: false,
            },
            State::SwallowEcho => {
                if text.is_empty() {
                    return Step::default();
                }
                self.state = State::Done;
                let rest = text
                    .strip_prefix("\r\n")
                    .or_else(|| text.strip_prefix('\n'))
                    .unwrap_or(text);
                Step {
                    emit: rest.to_string(),
                    reply: false,
                }
            }
            State::Watching { seen } => {
                let seen = seen + text.len();
                self.held.push_str(text);
                if let Some(at) = self.held.find(self.prompt) {
                    let after = self.held[at + self.prompt.len()..]
                        .trim_start_matches(' ')
                        .to_string();
                    let mut emit = self.held[..at].to_string();
                    self.held.clear();
                    if after.is_empty() {
                        self.state = State::SwallowEcho;
                    } else {
                        // Unlikely (the child waits for the reply before
                        // printing more), but never lose output over it.
                        self.state = State::Done;
                        emit.push_str(&after);
                    }
                    return Step { emit, reply: true };
                }
                if seen > WATCH_LIMIT {
                    self.state = State::Done;
                    return Step {
                        emit: std::mem::take(&mut self.held),
                        reply: false,
                    };
                }
                // Keep only the tail that could still grow into the prompt.
                let keep = self.possible_start();
                let emit = self.held[..keep].to_string();
                self.held.drain(..keep);
                self.state = State::Watching { seen };
                Step { emit, reply: false }
            }
        }
    }

    /// Text held back when the stream ends: it was not the prompt after all.
    pub fn finish(&mut self) -> String {
        self.state = State::Done;
        std::mem::take(&mut self.held)
    }

    /// Where the longest suffix of `held` that is a prefix of the prompt
    /// begins — `held.len()` when no suffix is.
    fn possible_start(&self) -> usize {
        let from = self.held.len().saturating_sub(self.prompt.len());
        (from..self.held.len())
            .filter(|&i| self.held.is_char_boundary(i))
            .find(|&i| self.prompt.starts_with(&self.held[i..]))
            .unwrap_or(self.held.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: Answer = Answer {
        prompt: "Please enter a connection string: ",
        reply: "\r",
    };

    fn run(chunks: &[&str]) -> (String, usize) {
        let mut a = Answerer::new(&ANSWER);
        let mut out = String::new();
        let mut replies = 0;
        for chunk in chunks {
            let step = a.push(chunk);
            out.push_str(&step.emit);
            replies += usize::from(step.reply);
        }
        out.push_str(&a.finish());
        (out, replies)
    }

    #[test]
    fn the_prompt_is_answered_once_and_never_shown() {
        let (out, replies) = run(&[
            "Debugger attached.\r\n",
            "Please enter a connection string: ",
            "\r\n",
            "Current Mongosh Log ID: 1\r\ntest> ",
        ]);
        assert_eq!(replies, 1);
        assert_eq!(
            out,
            "Debugger attached.\r\nCurrent Mongosh Log ID: 1\r\ntest> "
        );
    }

    #[test]
    fn a_prompt_split_across_reads_is_still_found() {
        let (out, replies) = run(&[
            "\x1b[?25lPlease en",
            "ter a conn",
            "ection string: ",
            "\r\nok",
        ]);
        assert_eq!(replies, 1);
        assert_eq!(out, "\x1b[?25lok");
    }

    /// What ConPTY actually sends, from `live_mongosh_on_windows_…`: the
    /// prompt's trailing space trimmed and an erase-to-end-of-line after it.
    #[test]
    fn the_prompt_is_found_as_conpty_renders_it() {
        let (out, replies) =
            run(&["\x1b[?25lPlease enter a connection string:\x1b[K\r\n\x1b[K\x1b[1;75H\x1b[?25h"]);
        assert_eq!(replies, 1);
        assert_eq!(out, "\x1b[?25l\x1b[K\r\n\x1b[K\x1b[1;75H\x1b[?25h");
    }

    #[test]
    fn output_that_cannot_be_the_prompt_is_not_held_back() {
        let mut a = Answerer::new(&ANSWER);
        // The REPL prompt of a child that never asks reaches the screen at
        // once, not when the watch limit runs out.
        assert_eq!(
            a.push("Current Mongosh Log ID: 1\r\ntest> "),
            Step {
                emit: "Current Mongosh Log ID: 1\r\ntest> ".into(),
                reply: false,
            }
        );
    }

    #[test]
    fn a_partial_match_is_released_when_it_stops_matching() {
        let (out, replies) = run(&["Please", " wait"]);
        assert_eq!(replies, 0);
        assert_eq!(out, "Please wait");
    }

    #[test]
    fn a_partial_match_is_released_when_the_stream_ends() {
        let (out, replies) = run(&["Please enter"]);
        assert_eq!(replies, 0);
        assert_eq!(out, "Please enter");
    }

    #[test]
    fn it_stops_watching_after_the_limit() {
        let long = "x".repeat(WATCH_LIMIT + 1);
        let (out, replies) = run(&[&long, "Please enter a connection string: "]);
        assert_eq!(replies, 0);
        assert_eq!(out, format!("{long}Please enter a connection string: "));
    }

    #[test]
    fn multibyte_text_is_never_split_inside_a_character() {
        let (out, _) = run(&["café → ", "ñandú"]);
        assert_eq!(out, "café → ñandú");
    }
}
