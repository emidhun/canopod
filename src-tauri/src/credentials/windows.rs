//! Protected DACLs are installed at creation, never patched after writing.
use super::{denied, File, Path};
use std::{io, os::windows::{ffi::OsStrExt, fs::MetadataExt, io::{AsRawHandle, FromRawHandle, OwnedHandle}}};
use windows::{core::{PCWSTR, PWSTR}, Win32::{
    Foundation::{HANDLE, HLOCAL, LocalFree, GENERIC_READ, GENERIC_WRITE},
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::Threading::{GetCurrentProcess, OpenProcessToken},
}};

fn win<T>(result: windows::core::Result<T>) -> io::Result<T> { result.map_err(io::Error::other) }
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL")) }
    value.push(0); Ok(value)
}

struct Allocation(*mut core::ffi::c_void);
// SAFETY: LocalAlloc buffers are owned, read-only after construction, and may
// be freed from any thread. Directory retains its descriptor for every user.
unsafe impl Send for Allocation {}
unsafe impl Sync for Allocation {}
impl Drop for Allocation { fn drop(&mut self) { unsafe { let _ = LocalFree(Some(HLOCAL(self.0))); } } }

fn descriptor() -> io::Result<Allocation> {
    unsafe {
        let mut handle = HANDLE::default();
        win(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle))?;
        let _token = OwnedHandle::from_raw_handle(handle.0);
        let mut needed = 0;
        let _ = GetTokenInformation(handle, TokenUser, None, 0, &mut needed);
        if needed < std::mem::size_of::<TOKEN_USER>() as u32 {
            return Err(denied("cannot read current user security identity"));
        }
        // TOKEN_USER contains pointers, so the output buffer must be aligned.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        win(GetTokenInformation(handle, TokenUser, Some(buffer.as_mut_ptr().cast()), needed, &mut needed))?;
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid_text = PWSTR::null();
        win(ConvertSidToStringSidW(user.User.Sid, &mut sid_text))?;
        let _sid = Allocation(sid_text.0.cast());
        let sid = sid_text.to_string().map_err(io::Error::other)?;
        // Explicit owner; protected DACL with one full-control ACE for that
        // user's SID. No inherited, group, SYSTEM or Administrators ACEs.
        let text: Vec<u16> = format!("O:{sid}D:P(A;;FA;;;{sid})").encode_utf16().chain(Some(0)).collect();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        win(ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(text.as_ptr()), SDDL_REVISION_1, &mut sd, None))?;
        Ok(Allocation(sd.0))
    }
}

fn attributes(sd: &Allocation) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: false.into(),
    }
}

// Keep every path component open without FILE_SHARE_DELETE. A directory
// cannot be swapped between validation and a later Win32 path-based open or
// rename while these handles live. The leaf DACL remains owner-only.
pub(super) struct Directory { handles: Vec<File>, descriptor: Allocation }
pub(super) fn prepare_directory(path: &Path) -> io::Result<Directory> {
    let sd = descriptor()?;
    let mut handles = Vec::new();
    let mut parents: Vec<_> = path.parent().ok_or_else(|| denied("credential parent missing"))?.ancestors().collect();
    parents.reverse();
    for parent in parents { handles.push(open_handle(parent, false, true, false, &sd)?); }
    let path_w = wide(path)?;
    let created = unsafe { CreateDirectoryW(PCWSTR(path_w.as_ptr()), Some(&attributes(&sd))) };
    if let Err(error) = created {
        if error.code() != windows::core::HRESULT::from_win32(183) { return Err(io::Error::other(error)) }
    }
    handles.push(open_handle(path, false, true, true, &sd)?);
    Ok(Directory { handles, descriptor: sd })
}

fn open_handle(path: &Path, create: bool, directory: bool, private: bool, sd: &Allocation) -> io::Result<File> {
    open_handle_access(path, create, directory, private, sd, false)
}
fn open_handle_access(path: &Path, create: bool, directory: bool, private: bool, sd: &Allocation, rename: bool) -> io::Result<File> {
    let path_w = wide(path)?;
    // Attribute-only handles do not participate in Windows sharing checks;
    // FILE_LIST_DIRECTORY (via GENERIC_READ) is necessary to pin a directory.
    let access = if directory { GENERIC_READ.0 }
        else if create { GENERIC_READ.0 | GENERIC_WRITE.0 | DELETE.0 }
        else { GENERIC_READ.0 | if rename { DELETE.0 } else { 0 } };
    let flags = FILE_FLAG_OPEN_REPARSE_POINT | if directory { FILE_FLAG_BACKUP_SEMANTICS } else { FILE_ATTRIBUTE_NORMAL };
    let handle = unsafe { CreateFileW(PCWSTR(path_w.as_ptr()), access,
        if directory { FILE_SHARE_READ | FILE_SHARE_WRITE } else { FILE_SHARE_READ | FILE_SHARE_DELETE }, Some(&attributes(sd)),
        if create { CREATE_NEW } else { OPEN_EXISTING }, flags, None) };
    let handle = handle.map_err(|error| match error.code().0 as u32 & 0xffff {
        2 | 3 => io::Error::new(io::ErrorKind::NotFound, "credential path does not exist"),
        80 | 183 => io::Error::new(io::ErrorKind::AlreadyExists, "credential path already exists"),
        _ => io::Error::other(error),
    })?;
    let file = unsafe { File::from_raw_handle(handle.0) };
    let validation = (|| -> io::Result<()> {
        #[cfg(test)]
        if create && super::take_creation_failure() { return Err(io::Error::other("injected post-create validation failure")) }
    let meta = file.metadata()?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || if directory { !meta.is_dir() } else { !meta.is_file() } {
        return Err(denied("credential path must not be a reparse point or special file"));
    }
    // Hard links are another path to a credential; disallow them as on Unix.
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { win(GetFileInformationByHandle(handle, &mut information))?; }
    // POSIX replacement can unlink an old token after this reader opened it
    // but before validation. Zero links on that private handle is safe; more
    // than one still means an alias. Newly created/renamed files must be linked.
    if !directory && (information.nNumberOfLinks > 1 || ((create || rename) && information.nNumberOfLinks != 1)) {
        return Err(denied("credential must not have hard links or an unlinked mutation target"));
    }
    if private { validate_acl(&file, sd)?; }
        Ok(())
    })();
    if let Err(error) = validation {
        if create {
            // Delete the exact newly created handle, even if validation failed.
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe { let _ = SetFileInformationByHandle(handle, FileDispositionInfo, (&disposition as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32); }
        }
        return Err(error);
    }
    Ok(file)
}

fn validate_acl(file: &File, expected: &Allocation) -> io::Result<()> {
    unsafe {
        let mut owner = PSID::default();
        let mut acl = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        win(GetSecurityInfo(HANDLE(file.as_raw_handle()), SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, Some(&mut owner), None,
            Some(&mut acl), None, Some(&mut sd)).ok())?;
        let _allocation = Allocation(sd.0);
        let mut expected_owner = PSID::default();
        let mut defaulted = false.into();
        win(GetSecurityDescriptorOwner(PSECURITY_DESCRIPTOR(expected.0), &mut expected_owner, &mut defaulted))?;
        win(EqualSid(owner, expected_owner)).map_err(|_| denied("credential owner is not the current user"))?;
        let mut control = 0;
        let mut revision = 0;
        win(GetSecurityDescriptorControl(sd, &mut control, &mut revision))?;
        if control & SE_DACL_PROTECTED.0 == 0 || acl.is_null() || (*acl).AceCount != 1 {
            return Err(denied("credential must have a protected owner-only DACL"));
        }
        let mut ace = std::ptr::null_mut();
        win(GetAce(acl, 0, &mut ace))?;
        let header = &*ace.cast::<ACE_HEADER>();
        // ACCESS_ALLOWED_ACE_TYPE = 0. Reject all other, inherited, object,
        // callback or conditional ACE types instead of interpreting their SID.
        if header.AceType != 0 || header.AceFlags != 0 || (header.AceSize as usize) < std::mem::size_of::<ACCESS_ALLOWED_ACE>() {
            return Err(denied("unsupported credential ACL entry"));
        }
        let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
        if allowed.Mask != FILE_ALL_ACCESS.0 { return Err(denied("unexpected credential ACL access mask")) }
        let sid = PSID((&allowed.SidStart as *const u32).cast_mut().cast());
        win(EqualSid(sid, expected_owner)).map_err(|_| denied("credential ACL grants another identity access"))?;
        Ok(())
    }
}

pub(super) fn check_directory(directory: &Directory) -> io::Result<()> {
    validate_acl(directory.handles.last().expect("pinned credential directory"), &directory.descriptor)
}
pub(super) fn create(directory: &Directory, path: &Path) -> io::Result<File> { open_handle(path, true, false, true, &directory.descriptor) }
pub(super) fn open(directory: &Directory, path: &Path) -> io::Result<File> { open_handle(path, false, false, true, &directory.descriptor) }
// Win32 does not provide a portable directory fsync here. File contents
// are flushed before the atomic handle rename. Ok means no
// reported I/O failure, not a guarantee against power loss.
pub(super) fn sync_directory(_: &Directory) -> io::Result<()> { Ok(()) }
pub(super) fn sync_file(file: &File) -> io::Result<()> { file.sync_all() }
pub(super) fn replace(directory: &Directory, from: &Path, to: &Path) -> io::Result<()> {
    let file = open_handle_access(from, false, false, true, &directory.descriptor, true)?;
    let target = wide(to)?;
    let bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + target.len() * 2;
    let length = u32::try_from(bytes).map_err(|_| denied("credential rename path too long"))?;
    // usize storage provides FILE_RENAME_INFO alignment and room for its
    // variable UTF-16 tail, including NUL. All bytes start initialized.
    let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let handle = HANDLE(file.as_raw_handle());
    unsafe {
        // FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS
        // keeps existing readers on the old object while new opens see the new
        // token. MoveFileExW rejects this case despite FILE_SHARE_DELETE.
        // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
        (*info).Anonymous.Flags = 0x1 | 0x2;
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = ((target.len() - 1) * 2) as u32;
        std::ptr::copy_nonoverlapping(target.as_ptr(), std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(), target.len());
        match SetFileInformationByHandle(handle, FileRenameInfoEx, info.cast(), length) {
            Ok(()) => Ok(()),
            // Older filesystems may lack extended rename flags. The classic
            // atomic rename remains fail-closed if an open reader blocks it.
            Err(error) if matches!(error.code().0 as u32 & 0xffff, 50 | 87) => {
                (*info).Anonymous.ReplaceIfExists = true;
                win(SetFileInformationByHandle(handle, FileRenameInfo, info.cast(), length))
            },
            Err(error) => Err(io::Error::other(error)),
        }
    }
}
pub(super) fn remove(directory: &Directory, path: &Path) -> io::Result<()> {
    // Only cleanup of our random rotation temporary; refuse a replaced alias.
    let file = open_handle(path, false, false, true, &directory.descriptor)?;
    drop(file);
    std::fs::remove_file(path)
}

// Every ancestor, including the leaf directory, is pinned against rename.
pub(super) fn temporary_names(_: &Directory, path: &Path) -> io::Result<Vec<std::ffi::OsString>> {
    let mut names = Vec::new();
    for (index, entry) in std::fs::read_dir(path)?.enumerate() {
        if index >= 1024 { return Err(io::Error::other("too many credential directory entries to recover safely")) }
        let name = entry?.file_name();
        if name.to_str().is_some_and(super::rotation_temporary) { names.push(name); }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{tests::Fixture, CredentialKind, CredentialStore};
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn readers_still_reject_hard_link_aliases() {
        let fixture = Fixture::new();
        let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        store.rotate(CredentialKind::Mcp, &owner).unwrap();
        let alias = fixture.0.join("token-alias");
        std::fs::hard_link(store.directory.join("mcp.token"), &alias).unwrap();
        assert!(store.load(CredentialKind::Mcp).is_err());
        assert!(store.rotate(CredentialKind::Mcp, &owner).is_err());
        std::fs::remove_file(alias).unwrap();
        assert!(store.load(CredentialKind::Mcp).unwrap().is_some());
    }

    #[test]
    fn rotation_preserves_a_reader_of_the_previous_token() {
        use std::io::Read;
        let fixture = Fixture::new();
        let owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp, &owner).unwrap().bearer;
        let mut reader = open(&store.anchor, &store.directory.join("mcp.token")).unwrap();
        let new = store.rotate(CredentialKind::Mcp, &owner).unwrap().bearer;
        let mut previous = String::new();
        reader.read_to_string(&mut previous).unwrap();
        assert!(old.matches(previous.trim()));
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(new.expose()));
    }

    #[test]
    fn credential_directory_junction_is_refused_without_touching_target() {
        let fixture = Fixture::new();
        let target = fixture.0.join("target"); std::fs::create_dir(&target).unwrap();
        let link = fixture.0.join("credentials");
        let result = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&target).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        assert!(CredentialStore::open(&fixture.0).is_err());
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
        std::fs::remove_dir(link).unwrap();
    }

    #[test]
    fn permissive_dacl_is_refused_without_replacing_the_credential() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let old = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        let file = std::fs::OpenOptions::new().access_mode(READ_CONTROL.0 | WRITE_DAC.0)
            .open(store.directory.join("mcp.token")).unwrap();
        let sd = descriptor().unwrap();
        unsafe {
            let handle = HANDLE(file.as_raw_handle());
            win(SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, Some(std::ptr::null()), None).ok()).unwrap();
            let refused = store.load(CredentialKind::Mcp).is_err() && store.rotate(CredentialKind::Mcp, &_owner).is_err();
            let mut present = false.into();
            let mut defaulted = false.into();
            let mut acl = std::ptr::null_mut();
            win(GetSecurityDescriptorDacl(PSECURITY_DESCRIPTOR(sd.0), &mut present, &mut acl, &mut defaulted)).unwrap();
            win(SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, Some(acl), None).ok()).unwrap();
            assert!(refused);
        }
        drop(file);
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(old.expose()));
    }

    #[test]
    fn directory_handles_prevent_replacement_until_store_closes() {
        let fixture = Fixture::new();
        let _owner = crate::ownership::RuntimeOwner::acquire(&fixture.0).unwrap();
        let store = CredentialStore::open(&fixture.0).unwrap();
        let original = store.rotate(CredentialKind::Mcp, &_owner).unwrap().bearer;
        let path = store.directory.clone();
        let moved = fixture.0.join("moved");
        assert!(std::fs::rename(&path, &moved).is_err());
        assert!(store.load(CredentialKind::Mcp).unwrap().unwrap().matches(original.expose()));
        drop(store);
        std::fs::rename(path, moved).unwrap();
    }
}
