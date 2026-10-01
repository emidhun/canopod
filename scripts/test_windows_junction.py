"""Platform-independent checks for the native Windows mutation-proof runner."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "junction_proof", Path(__file__).with_name("check-windows-junction.py")
)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class JunctionProofTests(unittest.TestCase):
    def test_compilation_failure_and_zero_tests_are_not_proofs(self):
        for code, output, expect_failure in [
            (101, "error: compilation failed", True),
            (0, "test result: ok. 0 passed; 0 failed", False),
            (0, "test result: ok. 1 passed; 0 failed", True),
        ]:
            with self.subTest(output=output, expect_failure=expect_failure):
                result = subprocess.CompletedProcess([], code, output, "")
                with patch.object(proof.subprocess, "run", return_value=result):
                    with self.assertRaises(RuntimeError):
                        proof.run_test(expect_failure)

    def test_mutation_restores_source_on_failure_or_timeout(self):
        for error in [RuntimeError("unexpected green"), subprocess.TimeoutExpired([], 600)]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "windows.rs"
                original = b"let flags = FILE_FLAG_OPEN_REPARSE_POINT | if directory\r\n"
                source.write_bytes(original)

                def run_test(expect_failure=False):
                    if expect_failure:
                        self.assertNotEqual(source.read_bytes(), original)
                        raise error

                with patch.object(proof, "SOURCE", source), patch.object(
                    proof.sys, "platform", "win32"
                ), patch.object(proof, "run_test", side_effect=run_test):
                    with self.assertRaises(type(error)):
                        proof.main()
                self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
