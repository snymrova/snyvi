//! What this build is: the version from Cargo.toml, and the commit and
//! target `build.rs` stamped it with ("" outside a checkout). On its own so
//! the CLI, the updater and the client read it without reaching into the
//! server, which is the one module that should depend on them and not the
//! other way round.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_SHA: &str = env!("SNYVI_GIT_SHA");
pub const BUILD_TARGET: &str = env!("SNYVI_TARGET");
