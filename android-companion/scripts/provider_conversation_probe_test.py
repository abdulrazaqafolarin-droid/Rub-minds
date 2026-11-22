#!/usr/bin/env python3
"""Unit tests for the local-only Android provider conversation probe."""
from __future__ import annotations

import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from provider_conversation_probe import analyse_snapshots, read_snapshot_bytes  # noqa: E402

CHATGPT = "com.openai.chatgpt"
SYSTEM_UI = "com.android.systemui"


def hierarchy(provider_labels: tuple[str, ...], include_system_ui: bool = True) -> bytes:
    root = ET.Element("hierarchy")
    for label in provider_labels:
        ET.SubElement(root, "node", {
            "package": CHATGPT,
            "class": "android.view.View",
            "text": label,
            "bounds": "[0,0][400,30]",
            "visible-to-user": "true",
            "clickable": "false",
            "editable": "false",
            "password": "false",
        })
    # A provider-owned content region establishes the full app viewport so the
    # upper-quarter header filter can be exercised realistically.
    ET.SubElement(root, "node", {
        "package": CHATGPT,
        "class": "android.view.View",
        "text": "",
        "bounds": "[0,300][400,900]",
        "visible-to-user": "true",
        "clickable": "false",
        "editable": "false",
        "password": "false",
    })
    if include_system_ui:
        ET.SubElement(root, "node", {
            "package": SYSTEM_UI,
            "class": "android.widget.TextView",
            "text": "System notification shade and navigation",
            "bounds": "[0,0][400,40]",
            "visible-to-user": "true",
            "clickable": "true",
            "editable": "false",
            "password": "false",
        })
    return ET.tostring(root, encoding="utf-8")


class ProviderConversationProbeTests(unittest.TestCase):
    def test_system_ui_nodes_are_ignored_and_only_provider_nodes_are_counted(self) -> None:
        raw = hierarchy(("Conversation A", "Provider-specific header"))
        snapshot = read_snapshot_bytes(raw, CHATGPT, b"k" * 32)
        self.assertEqual(snapshot.node_count, 3)
        self.assertEqual(len(snapshot.header_signals), 2)
        self.assertEqual(len(snapshot.send_signals), 0)

    def test_a_b_a_candidate_is_based_only_on_provider_owned_header_nodes(self) -> None:
        report = analyse_snapshots(CHATGPT, [
            hierarchy(("Conversation A", "Provider-specific header")),
            hierarchy(("Conversation B", "Provider-specific header")),
            hierarchy(("Conversation A", "Provider-specific header")),
        ])
        self.assertEqual(report["header_candidate_counts"], [2, 2, 2])
        self.assertEqual(report["a1_a2_header_similarity"], 1.0)
        self.assertTrue(report["repeatable_distinct_header_signal"])
        self.assertFalse(report["stable_provider_conversation_id_exposed"])
        self.assertFalse(report["native_send_enabled"])
        self.assertFalse(report["raw_text_printed_or_uploaded"])

    def test_snapshot_without_expected_provider_package_is_rejected(self) -> None:
        raw = hierarchy(("Conversation A",), include_system_ui=False).replace(
            CHATGPT.encode(), b"com.anthropic.claude"
        )
        with self.assertRaisesRegex(ValueError, "no nodes for the requested provider package"):
            read_snapshot_bytes(raw, CHATGPT, b"k" * 32)

    def test_dtd_and_entity_declarations_remain_rejected(self) -> None:
        malicious = b'<!DOCTYPE hierarchy [<!ENTITY x "unsafe">]><hierarchy><node package="' + CHATGPT.encode() + b'" /></hierarchy>'
        with self.assertRaisesRegex(ValueError, "DTD/entity declarations"):
            read_snapshot_bytes(malicious, CHATGPT, b"k" * 32)


if __name__ == "__main__":
    unittest.main()
