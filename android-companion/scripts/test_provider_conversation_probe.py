from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from provider_conversation_probe import analyse


def make_xml(title: str, package: str = "com.openai.chatgpt") -> str:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
    package="{package}" bounds="[0,0][1080,2400]" visible-to-user="true">
    <node index="0" text="{title}" content-desc="Selected conversation: {title}" resource-id="com.openai.chatgpt:id/conversation_title"
      class="android.widget.TextView" package="{package}" bounds="[20,80][900,170]"
      visible-to-user="true" />
    <node index="1" text="" content-desc="" resource-id="com.openai.chatgpt:id/prompt"
      class="android.widget.EditText" package="{package}" bounds="[20,2100][900,2280]"
      visible-to-user="true" enabled="true" editable="true" />
    <node index="2" text="" content-desc="Send message" resource-id="com.openai.chatgpt:id/send"
      class="android.widget.ImageButton" package="{package}" bounds="[920,2130][1060,2270]"
      visible-to-user="true" clickable="true" />
  </node>
</hierarchy>'''


class ProviderConversationProbeTests(unittest.TestCase):
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

    def test_identical_conversation_snapshots_do_not_claim_distinction(self) -> None:
        self.b.write_text(make_xml("Research chat A"), encoding="utf-8")
        report = analyse("com.openai.chatgpt", self.a1, self.b, self.a2)
        self.assertFalse(report["repeatable_distinct_header_signal"])

    def test_provider_package_mismatch_fails_closed(self) -> None:
        self.b.write_text(make_xml("Claude chat", "com.anthropic.claude"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "package does not match"):
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
