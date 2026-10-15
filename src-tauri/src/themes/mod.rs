//! VS Code colour themes: reading packages, talking to a registry, and the
//! on-disk library of what is installed.
//!
//! The division of labour with the frontend is the thing to keep straight, and
//! it is deliberate: **everything about colour lives in TypeScript**
//! (`src/lib/vscodeTheme/`), where it is pure, testable without a running app,
//! and checked against five real themes kept as fixtures. What lives here is
//! only what the frontend cannot do — unzip an archive, reach the network,
//! write a file — and none of it interprets a palette. See ADR #87.
//!
//! - [`vsix`] reads a `.vsix` (a ZIP) and produces the raw text of the theme
//!   files it contributes.
//! - [`registry`] is the Open VSX client: search, lookup, and a download that
//!   verifies the registry's published digest.
//! - [`store`] owns `installed_themes.json` — the editor themes and the
//!   metadata an update needs, alongside the palettes that stay in the
//!   frontend's localStorage.

pub mod registry;
pub mod store;
pub mod vsix;
