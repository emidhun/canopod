"""Prove the native Windows junction test detects following a reparse point.

Run on Windows from any directory. Source bytes are restored even when cargo
fails or times out. A compiler failure or zero selected tests is not a red proof.
"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src-tauri/src/credentials/windows.rs"
TEST = "credentials::platform::tests::credential_directory_junction_is_refused_without_touching_target"


def run_test(expect_failure=False):
    result = subprocess.run(
        ["cargo", "test", "--no-default-features", "--locked", "--lib", TEST,
         "--", "--exact", "--nocapture"],
        cwd=ROOT / "src-tauri", capture_output=True, text=True, timeout=600,
    )
    output = result.stdout + result.stderr
    print(output, flush=True)
    expected = "FAILED" if expect_failure else "ok"
    summary = "0 passed; 1 failed" if expect_failure else "1 passed; 0 failed"
    if (result.returncode != 0) != expect_failure or (
        f"test result: {expected}. {summary}" not in output
    ):
        raise RuntimeError("junction regression proof did not produce the expected test result")


def main():
    if sys.platform != "win32":
        raise SystemExit("this proof requires native Windows; cross-compilation is insufficient")
    original = SOURCE.read_bytes()
    protection = b"let flags = FILE_FLAG_OPEN_REPARSE_POINT | if directory"
    mutation = b"let flags = if directory"
    if original.count(protection) != 1:
        raise RuntimeError("junction protection changed; update the mutation explicitly")
    run_test()
    try:
        # Following the junction opens its private target instead of the link;
        # the test must reject this even though the target's permissions are safe.
        SOURCE.write_bytes(original.replace(protection, mutation, 1))
        run_test(expect_failure=True)
    finally:
        SOURCE.write_bytes(original)
    run_test()


if __name__ == "__main__":
    main()
