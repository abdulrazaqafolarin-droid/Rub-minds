#!/usr/bin/env python3
"""Local-only exploratory comparison of Android UIAutomator snapshots.

This tool does not identify a provider thread by itself. It reports whether
non-editable header accessibility signals are repeatable across A -> B -> A.
Raw text and descriptions are keyed-hashed in memory and never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import secrets
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

BOUNDS = re.compile(r"^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$")
GENERIC_LABELS = {
    "send", "send message", "message", "new chat", "new conversation",
    "back", "more options", "menu", "search", "voice", "microphone",
}


@dataclass(frozen=True)
class Snapshot:
    header_signals: frozenset[str]
    composer_signals: frozenset[str]
    send_signals: frozenset[str]
    node_count: int


def _digest(key: bytes, label: str, value: str) -> str:
    payload = (label + "\0" + value.strip()).encode("utf-8", errors="replace")
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def _bounds(value: str) -> tuple[int, int, int, int] | None:
    match = BOUNDS.fullmatch(value or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def _is_true(node: ET.Element, name: str) -> bool:
    return node.attrib.get(name, "").lower() == "true"


def _overlap(left: Iterable[str], right: Iterable[str]) -> float:
    a, b = set(left), set(right)
    if not a and not b:
        return 0.0
    union = a | b
    return len(a & b) / len(union) if union else 0.0


def _same_primary(left: frozenset[str], right: frozenset[str]) -> bool:
    return bool(left and right and _overlap(left, right) >= 0.8)


def read_snapshot(path: Path, package: str, key: bytes) -> Snapshot:
    try:
        if path.stat().st_size > 8_000_000:
            raise ValueError("Accessibility snapshot exceeds the 8 MB local safety limit.")
        raw_xml = path.read_bytes()
        upper_xml = raw_xml[:4096].upper()
        if b"<!DOCTYPE" in upper_xml or b"<!ENTITY" in upper_xml:
            raise ValueError("DTD/entity declarations are not accepted in accessibility snapshots.")
        root = ET.fromstring(raw_xml)
    except ValueError:
        raise
    except (ET.ParseError, OSError) as exc:
        raise ValueError("Could not read one accessibility snapshot as XML.") from exc

    if root.tag != "hierarchy":
        raise ValueError("Input is not an Android UIAutomator hierarchy.")
    nodes = list(root.iter("node"))
    if not nodes:
        raise ValueError("Snapshot contains no accessibility nodes.")
    packages = {node.attrib.get("package", "") for node in nodes if node.attrib.get("package")}
    if package not in packages or any(found != package for found in packages):
        raise ValueError("Snapshot package does not match the requested provider.")

    screen_bottom = max(
        (bounds[3] for node in nodes if (bounds := _bounds(node.attrib.get("bounds", "")))),
        default=0,
    )
    if screen_bottom <= 0:
        raise ValueError("Snapshot has no usable screen bounds.")

    header_signals: set[str] = set()
    composer_signals: set[str] = set()
    send_signals: set[str] = set()

    for node in nodes:
        attrs = node.attrib
        bounds = _bounds(attrs.get("bounds", ""))
        class_name = attrs.get("class", "")[:200]
        resource_id = attrs.get("resource-id", "")[:300]
        editable = _is_true(node, "editable") or class_name.endswith("EditText")
        password = _is_true(node, "password")
        visible = attrs.get("visible-to-user", "true").lower() != "false"
        clickable = _is_true(node, "clickable")

        if editable and not password and visible:
            signature = "\0".join((class_name, resource_id))
            composer_signals.add(_digest(key, "composer", signature))

        if clickable and visible:
            labels = " ".join((attrs.get("text", ""), attrs.get("content-desc", ""), resource_id)).lower()
            if "send" in labels and "resend" not in labels:
                signature = "\0".join((class_name, resource_id))
                send_signals.add(_digest(key, "send", signature))

        # Only inspect non-editable labels in the upper quarter of the screen.
        # Their values are never retained or displayed; they exist only long
        # enough to create a per-run keyed digest for the A/B/A comparison.
        if not visible or editable or password or bounds is None:
            continue
        if bounds[1] > screen_bottom * 0.28:
            continue

        for attribute in ("text", "content-desc"):
            value = attrs.get(attribute, "").strip()
            if len(value) < 2 or len(value) > 160:
                continue
            if value.lower() in GENERIC_LABELS:
                continue
            if any(ord(char) < 32 for char in value):
                continue
            header_signals.add(_digest(key, "header:" + attribute, value))

    return Snapshot(
        header_signals=frozenset(header_signals),
        composer_signals=frozenset(composer_signals),
        send_signals=frozenset(send_signals),
        node_count=len(nodes),
    )


def analyse(package: str, a1: Path, b: Path, a2: Path, delete_inputs: bool = False) -> dict[str, object]:
    try:
        if package not in {"com.openai.chatgpt", "com.anthropic.claude"}:
            raise ValueError("Only the official ChatGPT and Claude Android packages are supported.")
        key = secrets.token_bytes(32)
        snapshots = [read_snapshot(path, package, key) for path in (a1, b, a2)]
        first, other, repeat = snapshots

        repeat_overlap = _overlap(first.header_signals, repeat.header_signals)
        different_overlap = _overlap(first.header_signals, other.header_signals)
        candidate_signal = (
            len(first.header_signals) >= 2
            and len(repeat.header_signals) >= 2
            and repeat_overlap >= 0.70
            and different_overlap <= 0.40
        )

        report: dict[str, object] = {
            "provider": "ChatGPT" if package == "com.openai.chatgpt" else "Claude",
            "snapshots": "A1, B, A2",
            "node_counts": [item.node_count for item in snapshots],
            "header_candidate_counts": [len(item.header_signals) for item in snapshots],
            "a1_a2_header_similarity": round(repeat_overlap, 3),
            "a1_b_header_similarity": round(different_overlap, 3),
            "composer_control_reused_a_to_b": _same_primary(first.composer_signals, other.composer_signals),
            "send_control_reused_a_to_b": _same_primary(first.send_signals, other.send_signals),
            "repeatable_distinct_header_signal": candidate_signal,
            "stable_provider_conversation_id_exposed": False,
            "interpretation": (
                "candidate_signal_only_manual_adapter_review_required"
                if candidate_signal else "no_reliable_accessibility_candidate_found"
            ),
            "native_send_enabled": False,
            "raw_text_printed_or_uploaded": False,
        }

        return report
    finally:
        if delete_inputs:
            for path in (a1, b, a2):
                try:
                    path.unlink()
                except OSError:
                    pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, help="com.openai.chatgpt or com.anthropic.claude")
    parser.add_argument("--delete-inputs", action="store_true", help="Delete the three XML snapshots after analysis.")
    parser.add_argument("chat_a_first", type=Path)
    parser.add_argument("chat_b", type=Path)
    parser.add_argument("chat_a_repeat", type=Path)
    args = parser.parse_args()
    try:
        report = analyse(
            args.package, args.chat_a_first, args.chat_b, args.chat_a_repeat,
            delete_inputs=args.delete_inputs,
        )
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 2
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
