use super::{denied, File, Path};
use std::{ffi::CString, fs::{self, OpenOptions}, io, os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}}}};

pub(super) type Directory = File;

pub(super) fn prepare_directory(path: &Path) -> io::Result<Directory> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {},
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
        Err(error) => return Err(error),
    }
    validate_directory(path)
}

fn validate_directory(path: &Path) -> io::Result<Directory> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC).open(path)?;
    check_directory(&file)?;
    Ok(file)
}
pub(super) fn check_directory(directory: &Directory) -> io::Result<()> {
    let meta = directory.metadata()?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(denied("credential directory must be owned by the current user with mode 0700"));
    }
    Ok(())
}
fn name(path: &Path) -> io::Result<CString> {
    CString::new(path.file_name().ok_or_else(|| denied("credential filename missing"))?.as_bytes())
        .map_err(|_| denied("credential filename contains NUL"))
}
fn relative_open(directory: &Directory, path: &Path, flags: i32) -> io::Result<File> {
    let name = name(path)?;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK, 0o600 as libc::c_uint) };
    if fd < 0 { return Err(io::Error::last_os_error()) }
    let file = unsafe { File::from_raw_fd(fd) };
    let identity = file.metadata()?;
    #[cfg(test)]
    let fail = flags & libc::O_EXCL != 0 && super::take_creation_failure();
    #[cfg(not(test))]
    let fail = false;
    let result = if fail { Err(io::Error::other("injected post-create validation failure")) } else { validate(file, flags & libc::O_EXCL != 0) };
    if result.is_err() && flags & libc::O_EXCL != 0 {
        let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstatat(directory.as_raw_fd(), name.as_ptr(), current.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } == 0 {
            let current = unsafe { current.assume_init() };
            // libc device/inode widths differ across supported Unix targets.
            #[allow(clippy::unnecessary_cast)]
            let same_file = current.st_dev as u64 == identity.dev() && current.st_ino as u64 == identity.ino();
            if same_file {
                unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0); }
            }
        }
    }
    result
}

fn validate(file: File, require_linked: bool) -> io::Result<File> {
    let meta = file.metadata()?;
    // An atomic rotation may unlink a reader between openat and fstat.
    // Its private descriptor remains safe; a second hard link is never safe.
    if !meta.is_file() || (meta.nlink() > 1 || (require_linked && meta.nlink() != 1)) || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(denied("credential must be a private regular file owned by the current user, without hard links"));
    }
    Ok(file)
}

pub(super) fn create(directory: &Directory, path: &Path) -> io::Result<File> {
    relative_open(directory, path, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)
}
pub(super) fn open(directory: &Directory, path: &Path) -> io::Result<File> {
    relative_open(directory, path, libc::O_RDONLY)
}
pub(super) fn sync_directory(directory: &Directory) -> io::Result<()> { directory.sync_all() }
// std uses F_FULLFSYNC on Apple platforms; no duplicate fcntl is needed.
pub(super) fn sync_file(file: &File) -> io::Result<()> { file.sync_all() }

pub(super) fn temporary_names(directory: &Directory, _: &Path) -> io::Result<Vec<std::ffi::OsString>> {
    // A new open description avoids sharing a directory cursor across sweeps.
    let fd = unsafe { libc::openat(directory.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()) }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() { unsafe { libc::close(fd); } return Err(io::Error::last_os_error()) }
    struct Dir(*mut libc::DIR);
    impl Drop for Dir { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
    let stream = Dir(stream); let mut names = Vec::new();
    for _ in 0..1024 {
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        #[cfg(not(target_os = "linux"))]
        let errno = unsafe { libc::__error() };
        unsafe { *errno = 0; }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = unsafe { *errno };
            return if error == 0 { Ok(names) } else { Err(io::Error::from_raw_os_error(error)) };
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_str().is_ok_and(super::rotation_temporary) { names.push(std::ffi::OsStr::from_bytes(name.to_bytes()).to_owned()); }
    }
    Err(io::Error::other("too many credential directory entries to recover safely"))
}
pub(super) fn replace(directory: &Directory, from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (name(from)?, name(to)?);
    let fd = directory.as_raw_fd();
    if unsafe { libc::renameat(fd, from.as_ptr(), fd, to.as_ptr()) } < 0 { return Err(io::Error::last_os_error()) }
    Ok(())
}
pub(super) fn remove(directory: &Directory, path: &Path) -> io::Result<()> {
    let file = validate(relative_open(directory, path, libc::O_RDONLY)?, true)?;
    let identity = file.metadata()?;
    let name = name(path)?;
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstatat(directory.as_raw_fd(), name.as_ptr(), current.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } < 0 { return Err(io::Error::last_os_error()) }
    let current = unsafe { current.assume_init() };
    #[allow(clippy::unnecessary_cast)] // libc identity field widths vary by Unix platform
    let same = current.st_dev as u64 == identity.dev() && current.st_ino as u64 == identity.ino();
    if !same { return Err(denied("credential cleanup path changed after validation")) }
    // The pinned private directory and runtime writer guard exclude other
    // principals and concurrent Canopy mutations; same-user edits are trusted.
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } < 0 { return Err(io::Error::last_os_error()) }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{tests::Fixture, CredentialKind, CredentialStore};
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn opened_private_reader_remains_valid_after_atomic_replacement() {
        let fixture = Fixture::new();
        let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp, &owner).unwrap().bearer;
        let reader = File::open(store.directory.join("mcp.token")).unwrap();
        store.rotate(CredentialKind::Mcp, &owner).unwrap();
        assert_eq!(reader.metadata().unwrap().nlink(), 0);
        assert!(validate(reader.try_clone().unwrap(), true).is_err());
        let mut reader = validate(reader, false).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut reader, &mut text).unwrap();
        assert!(old.matches(text.trim()));
    }

    #[test]
    fn stale_cleanup_preserves_links_and_insecure_files() {
        let fixture = Fixture::new(); let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let safe = store.directory.join(format!(".rotate-{}", "a".repeat(32)));
        drop(create(&store.anchor, &safe).unwrap());
        let linked = store.directory.join(format!(".rotate-{}", "b".repeat(32)));
        drop(create(&store.anchor, &linked).unwrap());
        fs::hard_link(&linked, fixture.0.join("alias")).unwrap();
        let exposed = store.directory.join(format!(".rotate-{}", "c".repeat(32)));
        drop(create(&store.anchor, &exposed).unwrap());
        fs::set_permissions(&exposed, fs::Permissions::from_mode(0o644)).unwrap();
        let symlinked = store.directory.join(format!(".rotate-{}", "d".repeat(32)));
        symlink(&exposed, &symlinked).unwrap();
        store.rotate(CredentialKind::Mcp, &owner).unwrap();
        assert!(!safe.exists()); assert!(linked.exists()); assert!(exposed.exists()); assert!(symlinked.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[test]
    fn refuses_public_modes_links_and_non_regular_files() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let path = store.directory.join("mcp.token");
        store.rotate(CredentialKind::Mcp, &_owner).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.load(CredentialKind::Mcp).is_err());
        assert!(store.rotate(CredentialKind::Mcp, &_owner).is_err());
        fs::remove_file(&path).unwrap();
        let target = fixture.0.join("target");
        fs::write(&target, "preserve").unwrap();
        symlink(&target, &path).unwrap();
        assert!(store.load(CredentialKind::Mcp).is_err());
        assert!(store.rotate(CredentialKind::Mcp, &_owner).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "preserve");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.load(CredentialKind::Mcp).is_err());
    }

    #[test]
    fn directory_permissions_and_symlinks_fail_closed() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(CredentialStore::open(&fixture.0).is_err());
        fs::remove_dir(&store.directory).unwrap();
        let elsewhere = fixture.0.join("elsewhere");
        fs::DirBuilder::new().mode(0o700).create(&elsewhere).unwrap();
        symlink(&elsewhere, &store.directory).unwrap();
        assert!(CredentialStore::open(&fixture.0).is_err());
        assert!(fs::read_dir(elsewhere).unwrap().next().is_none());
    }

    #[test]
    fn failed_rotation_preserves_the_previous_credential() {
        if unsafe { libc::geteuid() } == 0 { return } // root bypasses mode checks
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o500)).unwrap();
        let failed = store.rotate(CredentialKind::Mcp, &_owner).is_err();
        fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed);
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(old.expose()));
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
    }

    #[test]
    fn directory_replacement_cannot_redirect_an_open_store() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let original = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        let moved = fixture.0.join("original");
        fs::rename(&store.directory, &moved).unwrap();
        let replacement = CredentialStore::open(&fixture.0).unwrap();
        let other = replacement.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(original.expose()));
        let rotated = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(rotated.expose()));
        assert!(replacement.load(CredentialKind::Mcp).unwrap().unwrap().matches(other.expose()));
    }
}
