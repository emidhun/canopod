//! Private credentials for distinct application and MCP trust boundaries.
//! No token implements Debug or Serialize. Callers must hold runtime ownership
//! and serialize rotations; this module never grants or changes permissions.
//! Root/Administrators and other processes running as this same user are trusted.
//! File permissions protect against other unprivileged local users, not those
//! trusted identities or processes that can read this process's memory.
use std::{fs::{self, File}, io::{self, Read, Write}, path::{Path, PathBuf}};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
#[path = "credentials/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "credentials/windows.rs"]
mod platform;

#[derive(Clone, Copy)]
pub enum CredentialKind { Application, Mcp }
impl CredentialKind {
    fn filename(self) -> &'static str {
        match self { Self::Application => "application.token", Self::Mcp => "mcp.token" }
    }
}

pub struct Bearer([u8; 64]);
impl Drop for Bearer { fn drop(&mut self) { self.0.zeroize(); } }
impl Bearer {
    fn generate() -> io::Result<Self> {
        let mut random = Zeroizing::new([0u8; 32]);
        getrandom::fill(random.as_mut()).map_err(io::Error::other)?;
        let hex = b"0123456789abcdef";
        let mut encoded = [0u8; 64];
        for (index, byte) in random.iter().enumerate() {
            encoded[index * 2] = hex[(byte >> 4) as usize];
            encoded[index * 2 + 1] = hex[(byte & 15) as usize];
        }
        Ok(Self(encoded))
    }

    /// Only deliberate credential export (private client configuration or an
    /// authenticated human action) should call this; never log the result.
    pub fn expose(&self) -> &str { std::str::from_utf8(&self.0).expect("validated hexadecimal") }
    pub fn matches(&self, presented: &str) -> bool {
        // Length is fixed public protocol metadata. Secret bytes use ct_eq.
        presented.len() == self.0.len() && bool::from(self.0.ct_eq(presented.as_bytes()))
    }
}

pub struct CredentialStore { directory: PathBuf, anchor: platform::Directory }

/// Once rename succeeds the new credential is committed and must become the
/// active value even if directory fsync subsequently fails. Returning that
/// warning separately avoids an old in-memory token with a new token on disk.
pub struct Rotation {
    pub bearer: Bearer,
    pub durability_warning: Option<io::Error>,
}

impl CredentialStore {
    pub fn open(data: &Path) -> io::Result<Self> {
        Self::open_mode(data, true)
    }

    pub fn open_existing(data: &Path) -> io::Result<Self> { Self::open_mode(data, false) }

    fn open_mode(data: &Path, create: bool) -> io::Result<Self> {
        let directory = fs::canonicalize(data)?.join("credentials");
        let anchor = platform::prepare_directory(&directory, create)?;
        Ok(Self { directory, anchor })
    }

    pub fn load(&self, kind: CredentialKind) -> io::Result<Option<Bearer>> {
        platform::check_directory(&self.anchor)?;
        let file = match platform::open(&self.anchor, &self.directory.join(kind.filename())) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut bytes = Zeroizing::new(Vec::with_capacity(65));
        file.take(65).read_to_end(&mut bytes)?;
        if bytes.len() != 64 || !bytes.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid credential encoding; rotate it explicitly"));
        }
        let mut bearer = Bearer([0; 64]);
        bearer.0.copy_from_slice(&bytes);
        Ok(Some(bearer))
    }

    /// Failure before atomic rename preserves the current credential. Missing
    /// credentials are created only through this explicit mutation.
    pub fn rotate(&self, kind: CredentialKind) -> io::Result<Rotation> {
        platform::check_directory(&self.anchor)?;
        // Validate an existing destination before replacement; never silently
        // repair exposed permissions or replace a symlink/reparse target.
        match platform::open(&self.anchor, &self.directory.join(kind.filename())) {
            Ok(_) => {},
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
        let bearer = Bearer::generate()?;
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(io::Error::other)?;
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let temporary = self.directory.join(format!(".rotate-{suffix}"));
        let mut file = platform::create(&self.anchor, &temporary)?;
        let outcome = (|| {
            file.write_all(&bearer.0)?;
            platform::sync_file(&file)?;
            drop(file);
            // Narrow the same-user check/replace window after slow disk work.
            // This is not an inode-CAS: same-user writers remain trusted and
            // callers serialize rotations under sole runtime ownership.
            match platform::open(&self.anchor, &self.directory.join(kind.filename())) {
                Ok(_) => {},
                Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                Err(error) => return Err(error),
            }
            platform::replace(&self.anchor, &temporary, &self.directory.join(kind.filename()))?;
            Ok(Rotation { bearer, durability_warning: platform::sync_directory(&self.anchor).err() })
        })();
        if outcome.is_err() { let _ = platform::remove(&self.anchor, &temporary); }
        outcome
    }
}

fn denied(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, message) }

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) struct Fixture(pub(super) PathBuf);
    impl Fixture {
        pub(super) fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("canopy-credentials-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn distinct_tokens_persist_and_rotation_replaces_only_the_selected_boundary() {
        let fixture = Fixture::new();
        let store = CredentialStore::open(&fixture.0).unwrap();
        assert!(store.load(CredentialKind::Application).unwrap().is_none());
        let app = store.rotate(CredentialKind::Application).unwrap().bearer;
        let mcp = store.rotate(CredentialKind::Mcp).unwrap().bearer;
        assert!(!app.matches(mcp.expose()));
        assert!(!app.matches(""));
        assert!(!app.matches(&"0".repeat(64)));
        let reloaded = CredentialStore::open(&fixture.0).unwrap();
        assert!(reloaded.load(CredentialKind::Application).unwrap().unwrap().matches(app.expose()));
        let next = store.rotate(CredentialKind::Mcp).unwrap().bearer;
        assert!(!next.matches(mcp.expose()));
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(next.expose()));
        assert!(store.load(CredentialKind::Application).unwrap().unwrap().matches(app.expose()));
    }

    #[test]
    fn malformed_and_oversized_credentials_are_refused_without_rewriting() {
        let fixture = Fixture::new();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let path = store.directory.join(CredentialKind::Mcp.filename());
        let mut file = platform::create(&store.anchor, &path).unwrap();
        file.write_all(&vec![b'a'; 4096]).unwrap();
        drop(file);
        assert!(store.load(CredentialKind::Mcp).is_err());
        assert_eq!(fs::metadata(path).unwrap().len(), 4096);
    }

    #[test]
    fn read_only_attachment_never_creates_missing_storage() {
        let fixture = Fixture::new();
        assert!(CredentialStore::open_existing(&fixture.0).is_err());
        assert!(!fixture.0.join("credentials").exists());
    }

    #[test]
    fn hard_link_alias_is_refused_on_read_and_rotation() {
        let fixture = Fixture::new();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp).unwrap().bearer;
        let alias = fixture.0.join("alias");
        fs::hard_link(store.directory.join("mcp.token"), &alias).unwrap();
        let refused = store.load(CredentialKind::Mcp).is_err() && store.rotate(CredentialKind::Mcp).is_err();
        fs::remove_file(alias).unwrap();
        assert!(refused);
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(old.expose()));
    }

    #[test]
    fn concurrent_readers_never_observe_partial_rotation() {
        let fixture = Fixture::new();
        let store = CredentialStore::open(&fixture.0).unwrap();
        store.rotate(CredentialKind::Mcp).unwrap();
        std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                for _ in 0..30 { assert_eq!(store.load(CredentialKind::Mcp).unwrap().unwrap().expose().len(), 64); }
            });
            for _ in 0..4 { store.rotate(CredentialKind::Mcp).unwrap(); }
            reader.join().unwrap();
        });
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
    }
}
