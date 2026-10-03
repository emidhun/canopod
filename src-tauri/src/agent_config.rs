//! User-scoped agent setup. Only explicit native actions reach this module.
//! Helpers read the private token on reconnect, so rotation needs no config rewrite.
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) fn target(client: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find your home directory")?;
    match client {
        "codex" => Ok(std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("config.toml")),
        "claude" => {
            if std::env::var_os("CLAUDE_CONFIG_DIR").is_some() {
                return Err("Claude Code uses a custom configuration directory. Use the manual connection fields for this setup.".into());
            }
            Ok(home.join(".claude.json"))
        }
        _ => Err("Choose Claude Code or Codex".into()),
    }
}

fn helper(token: &Path) -> Result<String, String> {
    let path = token.to_str().ok_or("Token path is not UTF-8")?;
    #[cfg(unix)]
    {
        Ok(format!(
            "printf '{{\"Authorization\":\"Bearer %s\"}}' \"$(cat {})\"",
            crate::toolchain::sh_quote(path)
        ))
    }
    #[cfg(windows)]
    {
        use base64::Engine;
        let script = format!("@{{Authorization = 'Bearer ' + [IO.File]::ReadAllText('{}').Trim()}} | ConvertTo-Json -Compress", path.replace('\'', "''"));
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        Ok(format!(
            "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}

/// The MCP server name the app registered before it was renamed.
const LEGACY_SERVER: &str = "canopy";

fn servers_own_legacy(helper: Option<&str>) -> bool {
    helper.is_some_and(|h| h.contains(crate::legacy::LEGACY_APP_ID))
}

fn merge(client: &str, original: &str, endpoint: &str, helper: &str) -> Result<String, String> {
    if client == "claude" {
        let mut config: serde_json::Value = if original.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(original)
                .map_err(|_| "Claude configuration is invalid JSON; it was not changed")?
        };
        let root = config
            .as_object_mut()
            .ok_or("Claude configuration must be an object")?;
        let servers = root
            .entry("mcpServers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("Claude mcpServers must be an object")?;
        if let Some(existing) = servers.get("canopod") {
            if existing["url"] != endpoint || existing.get("command").is_some() {
                return Err("An unrelated MCP server named canopod already exists. Rename it in your agent configuration or use manual setup.".into());
            }
        }
        let server = servers
            .entry("canopod")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("Claude canopod entry must be an object")?;
        server.insert("type".into(), "http".into());
        server.insert("url".into(), endpoint.into());
        server.insert("headersHelper".into(), helper.into());
        if let Some(headers) = server.get_mut("headers").and_then(|h| h.as_object_mut()) {
            headers.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
        }
        // The pre-rename entry ("canopy") is ours when its helper reads a token
        // from the old app directory; leaving it would register the app twice.
        if servers_own_legacy(servers.get(LEGACY_SERVER).and_then(|v| v["headersHelper"].as_str())) {
            servers.remove(LEGACY_SERVER);
        }
        serde_json::to_string_pretty(&config)
            .map(|s| s + "\n")
            .map_err(|e| e.to_string())
    } else if client == "codex" {
        let mut config = original
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "Codex configuration is invalid TOML; it was not changed")?;
        if !config.contains_key("mcp_servers") {
            config["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        let servers = config["mcp_servers"]
            .as_table_like_mut()
            .ok_or("Codex mcp_servers must be a table")?;
        if let Some(existing) = servers.get("canopod") {
            if existing.get("url").and_then(|v| v.as_str()) != Some(endpoint)
                || existing.get("command").is_some()
            {
                return Err("An unrelated MCP server named canopod already exists. Rename it in your agent configuration or use manual setup.".into());
            }
        } else {
            servers.insert("canopod", toml_edit::Item::Table(toml_edit::Table::new()));
        }
        let server = servers
            .get_mut("canopod")
            .unwrap()
            .as_table_like_mut()
            .ok_or("Codex canopod entry must be a table")?;
        server.insert("url", toml_edit::value(endpoint));
        server.insert("http_headers_helper", toml_edit::value(helper));
        server.insert("enabled", toml_edit::value(true));
        server.remove("bearer_token_env_var");
        for key in ["http_headers", "env_http_headers"] {
            if let Some(headers) = server.get_mut(key).and_then(|h| h.as_table_like_mut()) {
                let names: Vec<String> = headers
                    .iter()
                    .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                    .map(|(name, _)| name.to_owned())
                    .collect();
                for name in names {
                    headers.remove(&name);
                }
            }
        }
        let legacy = servers
            .get(LEGACY_SERVER)
            .and_then(|v| v.get("http_headers_helper"))
            .and_then(|v| v.as_str());
        if servers_own_legacy(legacy) {
            servers.remove(LEGACY_SERVER);
        }
        Ok(config.to_string())
    } else {
        Err("Choose Claude Code or Codex".into())
    }
}

fn read_config(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Agent configuration must be a regular file, not a link".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("Agent configuration must not be hard-linked".into());
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options
        .open(path)
        .map_err(|e| e.to_string())?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Agent configuration exceeds 4 MiB; use manual setup".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Agent configuration is not UTF-8".into())
}

fn install(path: &Path, client: &str, endpoint: &str, token: &Path) -> Result<(), String> {
    let original = read_config(path)?;
    let next = merge(
        client,
        original.as_deref().unwrap_or(""),
        endpoint,
        &helper(token)?,
    )?;
    let parent = path.parent().ok_or("Invalid agent configuration path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let mut temporary = tempfile::Builder::new()
        .make_in(parent, crate::credentials::create_private_config)
        .map_err(|e| e.to_string())?;
    temporary
        .write_all(next.as_bytes())
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    if read_config(path)? != original {
        return Err("Agent configuration changed while connecting; retry".into());
    }
    if original.is_none() {
        temporary.persist_noclobber(path).map_err(|e| e.error.to_string())?;
    } else {
        temporary.persist(path).map_err(|e| e.error.to_string())?;
    }
    Ok(())
}

pub(crate) async fn connect(
    client: String,
    controller: std::sync::Arc<crate::mcp::Controller>,
    app: crate::runtime::RuntimeContext,
) -> Result<String, String> {
    static WRITER: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    tokio::task::spawn_blocking(move || {
        let _guard = WRITER
            .try_lock()
            .ok_or("Agent setup is already in progress")?;
        if !controller.enabled() {
            return Err("Enable MCP before connecting an agent".into());
        }
        let path = target(&client)?;
        let endpoint = controller.status()["endpoint"]
            .as_str()
            .ok_or("MCP endpoint unavailable")?
            .to_owned();
        install(
            &path,
            &client,
            &endpoint,
            &app.path().data.join("credentials/mcp.token"),
        )?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Agent setup failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_unrelated_settings_and_reconnect_updates_only_canopod() {
        for (client, original) in [("claude", r#"{"theme":"dark","mcpServers":{"other":{"url":"https://example.test"}}}"#),
            ("codex", "# keep comment\nmodel = 'example'\n[mcp_servers.other]\nurl = 'https://example.test'\n")] {
            let result = merge(client, original, "http://127.0.0.1:47831/mcp", "helper-one").unwrap();
            assert!(result.contains("https://example.test"));
            let again = merge(client, &result, "http://127.0.0.1:47831/mcp", "helper-two").unwrap();
            assert!(again.contains("helper-two")); assert!(!again.contains("helper-one"));
            if client == "codex" { assert!(again.contains("# keep comment")); assert!(again.contains("model = 'example'")); }
        }
    }
    #[test]
    fn rejects_malformed_or_conflicting_config_without_rewriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        for (client, input) in [
            ("claude", "invalid"),
            ("codex", "[broken"),
            (
                "claude",
                r#"{"mcpServers":{"canopod":{"url":"https://other.test"}}}"#,
            ),
            (
                "codex",
                "[mcp_servers.canopod]\nurl = 'https://other.test'\n",
            ),
        ] {
            std::fs::write(&path, input).unwrap();
            assert!(install(
                &path,
                client,
                "http://127.0.0.1:47831/mcp",
                Path::new("/private/token")
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
        }
    }
    #[cfg(unix)]
    #[test]
    fn helper_quotes_paths_and_reads_rotated_token_without_embedding_it() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token with ' quote");
        let config = dir.path().join("config.toml");
        install(&config, "codex", "http://127.0.0.1:47831/mcp", &token).unwrap();
        for value in ["first-token", "rotated-token"] {
            std::fs::write(&token, value).unwrap();
            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg(helper(&token).unwrap())
                .output()
                .unwrap();
            let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["Authorization"], format!("Bearer {value}"));
            assert!(!std::fs::read_to_string(&config).unwrap().contains(value));
        }
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
