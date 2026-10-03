//! Private image attachments live only as long as their owning PTY session.
use std::io::Write;
const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_SESSION: usize = 64 * 1024 * 1024;
#[derive(Default)]
pub struct Attachments {
    files: Vec<tempfile::NamedTempFile>,
    bytes: usize,
}
impl Attachments {
    pub fn add(&mut self, data: &[u8]) -> Result<String, String> {
        if data.len() > MAX_IMAGE
            || self.bytes.saturating_add(data.len()) > MAX_SESSION
            || self.files.len() >= 16
        {
            return Err(
                "image attachment limit reached (8 MiB per image, 64 MiB or 16 images per session)"
                    .into(),
            );
        }
        let extension = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
            ".png"
        } else if data.starts_with(b"\xff\xd8\xff") {
            ".jpg"
        } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
            ".webp"
        } else {
            return Err("paste a PNG, JPEG or WebP image".into());
        };
        // tempfile uses exclusive creation and mode 0600 on Unix. Windows uses
        // the current user's temp directory and inherited private-user ACL.
        let mut file = tempfile::Builder::new()
            .prefix("canopod-image-")
            .suffix(extension)
            .tempfile()
            .map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        let path = file
            .path()
            .to_str()
            .ok_or("image path is not UTF-8")?
            .to_owned();
        self.bytes += data.len();
        self.files.push(file);
        Ok(path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_bytes_are_private_and_removed_with_the_session() {
        let mut attachments = Attachments::default();
        let data = b"\x89PNG\r\n\x1a\nimage payload";
        let path = attachments.add(data).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(attachments);
        assert!(!std::path::Path::new(&path).exists());
    }
    #[test]
    fn rejects_unknown_images_and_bounds_storage() {
        let mut attachments = Attachments::default();
        assert!(attachments.add(b"not an image").is_err());
        assert!(attachments.add(&vec![0; MAX_IMAGE + 1]).is_err());
        for _ in 0..16 {
            attachments.add(b"\xff\xd8\xff").unwrap();
        }
        assert!(attachments.add(b"\xff\xd8\xff").is_err());
    }
}
