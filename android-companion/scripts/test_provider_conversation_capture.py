from __future__ import annotations

import subprocess
import unittest
from unittest.mock import Mock

from capture_provider_conversation import capture_provider_sequence, capture_snapshot, resolve_device_serial


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
        with self.assertRaisesRegex(RuntimeError, "(?i)select one explicitly"):
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

    def test_provider_sequence_captures_a_b_a_and_deletes_every_remote_snapshot(self) -> None:
        def xml(title: str) -> bytes:
            return (f'''<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
    package="com.openai.chatgpt" bounds="[0,0][1080,2400]" visible-to-user="true">
    <node index="0" text="{title}" content-desc="Selected conversation: {title}"
      resource-id="com.openai.chatgpt:id/conversation_title"
      class="android.widget.TextView" package="com.openai.chatgpt"
      bounds="[20,80][900,170]" visible-to-user="true" />
    <node index="1" text="Conversation: {title}" content-desc="Conversation: {title}"
      resource-id="com.openai.chatgpt:id/conversation_subtitle"
      class="android.widget.TextView" package="com.openai.chatgpt"
      bounds="[20,180][900,240]" visible-to-user="true" />
    <node index="2" text="" resource-id="com.openai.chatgpt:id/prompt"
      class="android.widget.EditText" package="com.openai.chatgpt"
      bounds="[20,2100][900,2280]" visible-to-user="true" enabled="true" editable="true" />
  </node>
</hierarchy>''').encode("utf-8")

        snapshots = [xml("Disposable chat A"), xml("Disposable chat B"), xml("Disposable chat A")]
        responses = [subprocess.CompletedProcess(["adb"], 0,
            stdout="List of devices attached\nphone-1 device\n", stderr="")]
        for snapshot in snapshots:
            responses.extend([
                subprocess.CompletedProcess(["adb"], 0, stdout="UI hierarchy dumped", stderr=""),
                subprocess.CompletedProcess(["adb"], 0, stdout=snapshot, stderr=b""),
                subprocess.CompletedProcess(["adb"], 0, stdout="", stderr=""),
            ])
        runner = Mock(side_effect=responses)
        prompts: list[str] = []

        report = capture_provider_sequence(
            "com.openai.chatgpt",
            serial="phone-1",
            input_fn=lambda prompt: prompts.append(prompt) or "",
            runner=runner,
        )

        self.assertEqual(len(prompts), 3)
        self.assertIn("[A1]", prompts[0])
        self.assertIn("[B]", prompts[1])
        self.assertIn("[A2]", prompts[2])
        self.assertTrue(report["repeatable_distinct_header_signal"])
        self.assertFalse(report["stable_provider_conversation_id_exposed"])
        self.assertFalse(report["native_send_enabled"])
        self.assertNotIn("Disposable chat A", str(report))
        self.assertNotIn("Disposable chat B", str(report))
        self.assertEqual(runner.call_count, 10)

        commands = [call.args[0] for call in runner.call_args_list]
        cleanup_commands = [command for command in commands if command[3:6] == ["shell", "rm", "-f"]]
        self.assertEqual(len(cleanup_commands), 3)
        self.assertEqual(len({command[-1] for command in cleanup_commands}), 1)

    def test_invalid_provider_is_rejected_before_adb_or_prompt(self) -> None:
        runner = Mock()
        prompts: list[str] = []
        with self.assertRaisesRegex(ValueError, "Only the official"):
            capture_provider_sequence(
                "com.example.fake",
                input_fn=lambda prompt: prompts.append(prompt) or "",
                runner=runner,
            )
        runner.assert_not_called()
        self.assertEqual(prompts, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
