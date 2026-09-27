//! Private credentials for distinct application and MCP trust boundaries.
//! No token implements Debug or Serialize. Callers must hold runtime ownership
//! to rotate; the ownership guard serializes writers across store instances.
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
/// Windows has no portable directory fsync: None only means no reported error,
/// not a power-loss durability guarantee. Generations are process-local and
/// callers publishing rotations concurrently must reject older generations.
pub struct Rotation {
    pub bearer: Bearer,
    pub generation: u64,
    pub durability_warning: Option<io::Error>,
}

impl CredentialStore {
    pub fn open(data: &Path) -> io::Result<Self> {
        let directory = fs::canonicalize(data)?.join("credentials");
        let anchor = platform::prepare_directory(&directory)?;
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
    pub fn rotate(&self, kind: CredentialKind, owner: &crate::ownership::RuntimeOwner) -> io::Result<Rotation> {
        let mut generation = owner.credential_mutation(self.directory.parent().expect("credential parent"))?;
        let next_generation = generation.checked_add(1).ok_or_else(|| io::Error::other("credential generation exhausted"))?;
        platform::check_directory(&self.anchor)?;
        // Validate an existing destination before replacement; never silently
        // repair exposed permissions or replace a symlink/reparse target.
        match platform::open(&self.anchor, &self.directory.join(kind.filename())) {
            Ok(_) => {},
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
        let bearer = Bearer::generate()?;
        // Cleanup is a writer action, never performed by read-only clients.
        let temporary = self.directory.join(format!(".rotate-{}", kind.filename()));
        for name in platform::temporary_names(&self.anchor, &self.directory)? {
            let path = self.directory.join(name);
            match platform::open(&self.anchor, &path) {
                Ok(file) => { drop(file); platform::remove(&self.anchor, &path)?; }
                Err(error) if path == temporary => return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("unsafe rotation temporary {}; preserve and repair it before retrying: {error}", path.display()))),
                Err(error) => log::warn!("preserving unsafe credential temporary {}: {error}", path.display()),
            }
        }
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
            *generation = next_generation;
            Ok(Rotation { bearer, generation: next_generation, durability_warning: platform::sync_directory(&self.anchor).err() })
        })();
        if outcome.is_err() { let _ = platform::remove(&self.anchor, &temporary); }
        outcome
    }
}

#[cfg(test)]
thread_local! { static FAIL_CREATE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
fn take_creation_failure() -> bool { FAIL_CREATE.with(|flag| flag.replace(false)) }

fn rotation_temporary(name: &str) -> bool {
    matches!(name, ".rotate-application.token" | ".rotate-mcp.token") || name.strip_prefix(".rotate-")
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
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
    fn ownership_serializes_independent_stores_and_rejects_wrong_directory() {
        let fixture = Fixture::new(); let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let other = Fixture::new(); let other_owner = crate::ownership::RuntimeOwner::acquire(&other.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        assert!(store.rotate(CredentialKind::Mcp, &other_owner).is_err());
        let rotations = std::thread::scope(|scope| {
            let mut threads = Vec::new();
            for _ in 0..4 {
                let owner = &owner; let path = &fixture.0;
                threads.push(scope.spawn(move || {
                    let store = CredentialStore::open(path).unwrap();
                    (0..8).map(|_| store.rotate(CredentialKind::Mcp, owner).unwrap()).collect::<Vec<_>>()
                }));
            }
            threads.into_iter().flat_map(|thread| thread.join().unwrap()).collect::<Vec<_>>()
        });
        let mut generations: Vec<_> = rotations.iter().map(|r| r.generation).collect();
        generations.sort_unstable();
        assert_eq!(generations, (1..=32).collect::<Vec<_>>());
        let latest = rotations.iter().max_by_key(|r| r.generation).unwrap();
        assert!(rotations.iter().all(|r| r.durability_warning.is_none()));
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(latest.bearer.expose()));
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
    }

    #[test]
    fn failure_after_temporary_creation_cleans_up_and_preserves_token() {
        let fixture = Fixture::new(); let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp, &owner).unwrap().bearer;
        FAIL_CREATE.with(|flag| flag.set(true));
        assert!(store.rotate(CredentialKind::Mcp, &owner).is_err());
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(old.expose()));
    }

    #[test]
    fn only_writers_remove_valid_crash_temporaries() {
        let fixture = Fixture::new(); let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let path = store.directory.join(format!(".rotate-{}", "a".repeat(32)));
        drop(platform::create(&store.anchor, &path).unwrap());
        let reader = CredentialStore::open(&fixture.0).unwrap();
        assert!(reader.load(CredentialKind::Mcp).unwrap().is_none());
        assert!(path.exists());
        store.rotate(CredentialKind::Mcp, &owner).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn distinct_tokens_persist_and_rotation_replaces_only_the_selected_boundary() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        assert!(store.load(CredentialKind::Application).unwrap().is_none());
        let rotation = store.rotate(CredentialKind::Application, &_owner).unwrap();
        assert!(rotation.durability_warning.is_none());
        let app = rotation.bearer;
        let mcp = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        assert!(!app.matches(mcp.expose()));
        assert!(!app.matches(""));
        assert!(!app.matches(&"0".repeat(64)));
        let reloaded = CredentialStore::open(&fixture.0).unwrap();
        assert!(reloaded.load(CredentialKind::Application).unwrap().unwrap().matches(app.expose()));
        let next = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        assert!(!next.matches(mcp.expose()));
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(next.expose()));
        assert!(store.load(CredentialKind::Application).unwrap().unwrap().matches(app.expose()));
    }

    #[test]
    fn malformed_and_oversized_credentials_are_refused_without_rewriting() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let path = store.directory.join(CredentialKind::Mcp.filename());
        let mut file = platform::create(&store.anchor, &path).unwrap();
        file.write_all(&vec![b'a'; 4096]).unwrap();
        drop(file);
        assert!(store.load(CredentialKind::Mcp).is_err());
        assert_eq!(fs::metadata(path).unwrap().len(), 4096);
    }

    #[test]
    fn hard_link_alias_is_refused_on_read_and_rotation() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        let alias = fixture.0.join("alias");
        fs::hard_link(store.directory.join("mcp.token"), &alias).unwrap();
        let refused = store.load(CredentialKind::Mcp).is_err() && store.rotate(CredentialKind::Mcp, &_owner).is_err();
        fs::remove_file(alias).unwrap();
        assert!(refused);
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(old.expose()));
    }

    #[test]
    fn concurrent_readers_never_observe_partial_rotation() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        store.rotate(CredentialKind::Mcp, &_owner).unwrap();
        std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                for _ in 0..30 { assert_eq!(store.load(CredentialKind::Mcp).unwrap().unwrap().expose().len(), 64); }
            });
            for _ in 0..4 { store.rotate(CredentialKind::Mcp, &_owner).unwrap(); }
            reader.join().unwrap();
        });
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
    }
}
