from __future__ import annotations

import subprocess
import unittest
from unittest.mock import Mock

from capture_provider_conversation import capture_snapshot, resolve_device_serial


class AdbCaptureTests(unittest.TestCase):
    def test_uses_the_only_authorized_device(self) -> None:
        runner = Mock(return_value=subprocess.CompletedProcess(
            ["adb", "devices", "-l"], 0,
            stdout="List of devices attached\nphone-123 device product:test\noffline-1 offline\n",
            stderr="",
        ))
        self.assertEqual(resolve_device_serial(runner=runner), "phone-123")

    def test_multiple_devices_require_an_explicit_serial(self) -> None:
        runner = Mock(return_value=subprocess.CompletedProcess(
            ["adb", "devices", "-l"], 0,
            stdout="List of devices attached\nphone-1 device\nphone-2 device\n",
            stderr="",
        ))
        with self.assertRaisesRegex(RuntimeError, "select one explicitly"):
            resolve_device_serial(runner=runner)

    def test_explicit_serial_must_be_connected_and_authorized(self) -> None:
        runner = Mock(return_value=subprocess.CompletedProcess(
            ["adb", "devices", "-l"], 0,
            stdout="List of devices attached\nphone-1 unauthorized\nphone-2 device\n",
            stderr="",
        ))
        with self.assertRaisesRegex(RuntimeError, "not connected and authorized"):
            resolve_device_serial("phone-1", runner=runner)

    def test_capture_reads_bounded_bytes_and_deletes_device_xml(self) -> None:
        xml = b"<hierarchy />"
        runner = Mock(side_effect=[
            subprocess.CompletedProcess(["adb"], 0, stdout="UI hierarchy dumped", stderr=""),
            subprocess.CompletedProcess(["adb"], 0, stdout=xml, stderr=b""),
            subprocess.CompletedProcess(["adb"], 0, stdout="", stderr=""),
        ])
        captured = capture_snapshot(
            "phone-1",
            "/sdcard/rm-provider-identity-0123456789abcdef.xml",
            runner=runner,
        )
        self.assertEqual(captured, xml)
        commands = [call.args[0] for call in runner.call_args_list]
        self.assertEqual(commands[0][3:7], ["shell", "uiautomator", "dump", "--compressed"])
        self.assertEqual(commands[1][3:6], ["exec-out", "head", "-c"])
        self.assertEqual(commands[2][-3:], ["rm", "-f", "/sdcard/rm-provider-identity-0123456789abcdef.xml"])

    def test_failed_dump_still_attempts_remote_cleanup(self) -> None:
        runner = Mock(side_effect=[
            subprocess.CompletedProcess(["adb"], 1, stdout="", stderr="failed"),
            subprocess.CompletedProcess(["adb"], 0, stdout="", stderr=""),
        ])
        with self.assertRaisesRegex(RuntimeError, "could not capture"):
            capture_snapshot(
                "phone-1",
                "/sdcard/rm-provider-identity-0123456789abcdef.xml",
                runner=runner,
            )
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(runner.call_args_list[1].args[0][-2:], ["-f", "/sdcard/rm-provider-identity-0123456789abcdef.xml"])

    def test_oversized_capture_is_rejected_and_cleaned_up(self) -> None:
        runner = Mock(side_effect=[
            subprocess.CompletedProcess(["adb"], 0, stdout="ok", stderr=""),
            subprocess.CompletedProcess(["adb"], 0, stdout=b"x" * 8_000_001, stderr=b""),
            subprocess.CompletedProcess(["adb"], 0, stdout="", stderr=""),
        ])
        with self.assertRaisesRegex(ValueError, "8 MB"):
            capture_snapshot(
                "phone-1",
                "/sdcard/rm-provider-identity-0123456789abcdef.xml",
                runner=runner,
            )
        self.assertEqual(runner.call_count, 3)

    def test_cleanup_failure_is_reported_without_returning_captured_xml(self) -> None:
        runner = Mock(side_effect=[
            subprocess.CompletedProcess(["adb"], 0, stdout="ok", stderr=""),
            subprocess.CompletedProcess(["adb"], 0, stdout=b"<hierarchy/>", stderr=b""),
            subprocess.CompletedProcess(["adb"], 1, stdout="", stderr="cleanup failed"),
        ])
        with self.assertRaisesRegex(RuntimeError, "Could not confirm deletion"):
            capture_snapshot(
                "phone-1",
                "/sdcard/rm-provider-identity-0123456789abcdef.xml",
                runner=runner,
            )

    def test_rejects_unexpected_remote_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "path is invalid"):
            capture_snapshot("phone-1", "/sdcard/private.xml", runner=Mock())


if __name__ == "__main__":
    unittest.main(verbosity=2)
