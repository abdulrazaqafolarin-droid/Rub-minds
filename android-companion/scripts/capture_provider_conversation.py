#!/usr/bin/env python3
"""Capture a privacy-preserving Android provider A -> B -> A identity probe.

Only aggregate similarity metrics are printed. Accessibility XML is read into
memory, analysed with a per-run HMAC key, and removed from the phone immediately
after each capture. This is diagnostic tooling, not a conversation-ID resolver.
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import subprocess
from typing import Callable

from provider_conversation_probe import analyse_snapshots

MAX_CAPTURE_BYTES = 8_000_000
CAPTURE_TIMEOUT_SECONDS = 30
DEVICE_LIST_TIMEOUT_SECONDS = 15
ALLOWED_PACKAGES = {"com.openai.chatgpt", "com.anthropic.claude"}


def _run(command: list[str], *, runner: Callable = subprocess.run, **kwargs):
    try:
        return runner(command, **kwargs)
    except FileNotFoundError as exc:
        raise RuntimeError("Android Platform Tools (adb) were not found. Install adb and add it to PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("The Android device did not respond before the bounded command timeout.") from exc


def resolve_device_serial(
    serial: str | None = None,
    adb: str = "adb",
    runner: Callable = subprocess.run,
) -> str:
    result = _run(
        [adb, "devices", "-l"],
        runner=runner,
        capture_output=True,
        text=True,
        timeout=DEVICE_LIST_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Could not list Android devices. Check the adb installation and USB connection.")

    available: list[str] = []
    for line in (result.stdout or "").splitlines()[1:]:
        columns = line.split()
        if len(columns) >= 2 and columns[1] == "device":
            available.append(columns[0])

    if serial:
        if serial not in available:
            raise RuntimeError("The requested device is not connected and authorized for adb.")
        return serial
    if len(available) == 1:
        return available[0]
    if not available:
        raise RuntimeError("No authorized Android device was found. Unlock the phone and approve its USB debugging prompt.")
    raise RuntimeError("More than one Android device is connected. Select one explicitly with --serial.")


def capture_snapshot(
    serial: str,
    remote_path: str,
    adb: str = "adb",
    runner: Callable = subprocess.run,
) -> bytes:
    if not re.fullmatch(r"/sdcard/rm-provider-identity-[a-f0-9]{16}\\.xml", remote_path):
        raise ValueError("The temporary device capture path is invalid.")

    primary_error: Exception | None = None
    raw_xml: bytes | None = None
    try:
        dump = _run(
            [adb, "-s", serial, "shell", "uiautomator", "dump", "--compressed", remote_path],
            runner=runner,
            capture_output=True,
            text=True,
            timeout=CAPTURE_TIMEOUT_SECONDS,
            check=False,
        )
        if dump.returncode != 0:
            raise RuntimeError("Android UIAutomator could not capture the current provider screen.")

        captured = _run(
            [adb, "-s", serial, "exec-out", "head", "-c", str(MAX_CAPTURE_BYTES + 1), remote_path],
            runner=runner,
            capture_output=True,
            timeout=CAPTURE_TIMEOUT_SECONDS,
            check=False,
        )
        if captured.returncode != 0:
            raise RuntimeError("Could not read the temporary Android accessibility capture.")
        raw_xml = captured.stdout or b""
        if not raw_xml:
            raise RuntimeError("Android returned an empty accessibility capture.")
        if len(raw_xml) > MAX_CAPTURE_BYTES:
            raise ValueError("Accessibility snapshot exceeds the 8 MB local safety limit.")
    except Exception as exc:
        primary_error = exc
    finally:
        cleanup = None
        try:
            cleanup = _run(
                [adb, "-s", serial, "shell", "rm", "-f", remote_path],
                runner=runner,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except Exception:
            cleanup = None
        if cleanup is None or cleanup.returncode != 0:
            raise RuntimeError(
                "Could not confirm deletion of the temporary accessibility XML on the phone. "
                "Before continuing, run: adb -s DEVICE_SERIAL shell rm -f " + remote_path
            ) from primary_error

    if primary_error is not None:
        raise primary_error
    if raw_xml is None:
        raise RuntimeError("Android accessibility capture did not produce data.")
    return raw_xml


def capture_provider_sequence(
    package: str,
    serial: str | None = None,
    adb: str = "adb",
    input_fn: Callable[[str], str] = input,
    runner: Callable = subprocess.run,
) -> dict[str, object]:
    if package not in ALLOWED_PACKAGES:
        raise ValueError("Only the official ChatGPT and Claude Android packages are supported.")

    device = resolve_device_serial(serial=serial, adb=adb, runner=runner)
    remote_path = "/sdcard/rm-provider-identity-" + secrets.token_hex(8) + ".xml"
    captures: list[bytes] = []
    steps = (
        ("A1", "Open disposable test conversation A and wait until it is fully loaded."),
        ("B", "Switch to a different disposable test conversation B and wait until it is fully loaded."),
        ("A2", "Return to the original disposable conversation A and wait until it is fully loaded."),
    )
    for label, instruction in steps:
        input_fn(f"\n[{label}] {instruction}\nPress Enter to capture this screen (Ctrl+C to stop): ")
        captures.append(capture_snapshot(device, remote_path, adb=adb, runner=runner))

    return analyse_snapshots(package, captures)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, help="com.openai.chatgpt or com.anthropic.claude")
    parser.add_argument("--serial", help="adb device serial; required when multiple devices are connected")
    parser.add_argument("--adb", default="adb", help="adb executable (default: adb)")
    args = parser.parse_args()
    try:
        report = capture_provider_sequence(args.package, serial=args.serial, adb=args.adb)
    except (ValueError, RuntimeError) as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"status": "cancelled", "native_send_enabled": False}, indent=2))
        return 130
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
