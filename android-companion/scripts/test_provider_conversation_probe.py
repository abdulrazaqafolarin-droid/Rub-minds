from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from provider_conversation_probe import analyse, analyse_snapshots


def make_xml(
    title: str,
    package: str = "com.openai.chatgpt",
    include_secondary_header: bool = True,
) -> str:
    secondary_header = (
        f'''    <node index="3" text="Workspace" content-desc="Workspace"
      resource-id="{package}:id/workspace_header" class="android.widget.TextView"
      package="{package}" bounds="[20,180][900,240]" visible-to-user="true" />'''
        if include_secondary_header else ""
    )
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
    package="{package}" bounds="[0,0][1080,2400]" visible-to-user="true">
    <node index="0" text="{title}" content-desc="Selected conversation: {title}" resource-id="{package}:id/conversation_title"
      class="android.widget.TextView" package="{package}" bounds="[20,80][900,170]"
      visible-to-user="true" />
{secondary_header}
    <node index="1" text="" content-desc="" resource-id="{package}:id/prompt"
      class="android.widget.EditText" package="{package}" bounds="[20,2100][900,2280]"
      visible-to-user="true" enabled="true" editable="true" />
    <node index="2" text="" content-desc="Send message" resource-id="{package}:id/send"
      class="android.widget.ImageButton" package="{package}" bounds="[920,2130][1060,2270]"
      visible-to-user="true" clickable="true" />
  </node>
</hierarchy>'''


class ProviderConversationProbeTests(unittest.TestCase):
    def test_documented_cli_wrapper_imports_the_probe_module(self) -> None:
        script = Path(__file__).with_name("provider-conversation-probe.py")
        result = subprocess.run(
            [sys.executable, str(script), "--help"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--package", result.stdout)
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.a1 = self.root / "a1.xml"
        self.b = self.root / "b.xml"
        self.a2 = self.root / "a2.xml"
        self.a1.write_text(make_xml("Research chat A"), encoding="utf-8")
        self.b.write_text(make_xml("Business chat B"), encoding="utf-8")
        self.a2.write_text(make_xml("Research chat A"), encoding="utf-8")

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_repeatable_header_candidate_differs_between_conversations(self) -> None:
        report = analyse("com.openai.chatgpt", self.a1, self.b, self.a2)
        self.assertTrue(report["repeatable_distinct_header_signal"])
        self.assertTrue(report["composer_control_reused_a_to_b"])
        self.assertTrue(report["send_control_reused_a_to_b"])
        self.assertFalse(report["native_send_enabled"])
        self.assertFalse(report["stable_provider_conversation_id_exposed"])

    def test_text_and_content_description_on_one_node_count_as_one_signal(self) -> None:
        xml = make_xml("Research chat A", include_secondary_header=False).encode("utf-8")
        report = analyse_snapshots("com.openai.chatgpt", [xml, xml, xml])
        self.assertEqual(report["header_candidate_counts"], [1, 1, 1])
        self.assertFalse(report["repeatable_distinct_header_signal"])

    def test_in_memory_analysis_matches_file_analysis_without_exposing_raw_titles(self) -> None:
        report = analyse_snapshots(
            "com.openai.chatgpt",
            [
                self.a1.read_bytes(),
                self.b.read_bytes(),
                self.a2.read_bytes(),
            ],
        )
        self.assertTrue(report["repeatable_distinct_header_signal"])
        self.assertFalse(report["stable_provider_conversation_id_exposed"])
        self.assertFalse(report["native_send_enabled"])
        self.assertFalse(report["raw_text_printed_or_uploaded"])
        self.assertNotIn("Research chat A", str(report))
        self.assertNotIn("Business chat B", str(report))

    def test_in_memory_analysis_requires_exactly_three_snapshots(self) -> None:
        with self.assertRaisesRegex(ValueError, "Exactly three"):
            analyse_snapshots("com.openai.chatgpt", [self.a1.read_bytes()])

    def test_in_memory_analysis_rejects_unsupported_provider(self) -> None:
        with self.assertRaisesRegex(ValueError, "Only the official"):
            analyse_snapshots("com.example.fake", [b"<hierarchy/>"] * 3)

    def test_identical_conversation_snapshots_do_not_claim_distinction(self) -> None:
        self.b.write_text(make_xml("Research chat A"), encoding="utf-8")
        report = analyse("com.openai.chatgpt", self.a1, self.b, self.a2)
        self.assertFalse(report["repeatable_distinct_header_signal"])

    def test_provider_package_mismatch_fails_closed(self) -> None:
        self.b.write_text(make_xml("Claude chat", "com.anthropic.claude"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "no nodes for the requested provider package"):
            analyse("com.openai.chatgpt", self.a1, self.b, self.a2)

    def test_only_supported_provider_packages_are_accepted(self) -> None:
        with self.assertRaisesRegex(ValueError, "Only the official"):
            analyse("com.example.fake", self.a1, self.b, self.a2)

    def test_delete_inputs_removes_only_the_three_input_files(self) -> None:
        report = analyse("com.openai.chatgpt", self.a1, self.b, self.a2, delete_inputs=True)
        self.assertFalse(self.a1.exists())
        self.assertFalse(self.b.exists())
        self.assertFalse(self.a2.exists())
        self.assertFalse(report["native_send_enabled"])

    def test_raw_titles_are_never_returned_in_the_report(self) -> None:
        report = analyse("com.openai.chatgpt", self.a1, self.b, self.a2)
        self.assertNotIn("Research chat A", str(report))
        self.assertNotIn("Business chat B", str(report))
        self.assertFalse(report["stable_provider_conversation_id_exposed"])

    def test_invalid_xml_still_deletes_all_inputs_when_requested(self) -> None:
        self.b.write_text("<!DOCTYPE hierarchy [<!ENTITY x 'boom'>]><hierarchy/>", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "DTD/entity"):
            analyse("com.openai.chatgpt", self.a1, self.b, self.a2, delete_inputs=True)
        self.assertFalse(self.a1.exists())
        self.assertFalse(self.b.exists())
        self.assertFalse(self.a2.exists())

    def test_dtd_after_long_leading_comment_is_rejected(self) -> None:
        self.b.write_text("<!-- " + "x" * 5000 + " -->\\n<!DOCTYPE hierarchy [<!ENTITY x 'boom'>]><hierarchy/>", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "DTD/entity"):
            analyse("com.openai.chatgpt", self.a1, self.b, self.a2, delete_inputs=True)
        self.assertFalse(self.a1.exists())
        self.assertFalse(self.b.exists())
        self.assertFalse(self.a2.exists())

    def test_cleanup_failure_is_reported_instead_of_silently_ignored(self) -> None:
        with patch.object(Path, "unlink", side_effect=PermissionError("blocked")):
            with self.assertRaisesRegex(RuntimeError, "Could not delete"):
                analyse("com.openai.chatgpt", self.a1, self.b, self.a2, delete_inputs=True)

    def test_utf16_dtd_snapshot_is_rejected_and_all_inputs_are_deleted(self) -> None:
        payload = (
            '<?xml version="1.0" encoding="UTF-16"?>'
            '<!DOCTYPE hierarchy [<!ENTITY x "expanded">]>'
            '<hierarchy><node package="com.openai.chatgpt" /></hierarchy>'
        )
        self.b.write_bytes(payload.encode("utf-16"))
        with self.assertRaisesRegex(ValueError, "UTF-8 XML"):
            analyse("com.openai.chatgpt", self.a1, self.b, self.a2, delete_inputs=True)
        self.assertFalse(self.a1.exists())
        self.assertFalse(self.b.exists())
        self.assertFalse(self.a2.exists())

    def test_non_hierarchy_xml_is_rejected(self) -> None:
        self.a1.write_text("<wrong><node /></wrong>", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "UIAutomator hierarchy"):
            analyse("com.openai.chatgpt", self.a1, self.b, self.a2)

    def test_oversized_snapshot_is_rejected(self) -> None:
        self.a1.write_text("x" * (8_000_001), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "8 MB"):
            analyse("com.openai.chatgpt", self.a1, self.b, self.a2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
