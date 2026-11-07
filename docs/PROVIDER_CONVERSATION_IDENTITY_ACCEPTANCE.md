# Provider-conversation identity: physical-device acceptance

## Safety boundary

This is a **read-only investigation** for ChatGPT and Claude on Android. Do not enable native wake, invoke Send, or use a real private conversation. Use two disposable test conversations with harmless titles and no personal data. The probe only compares accessibility-tree snapshots; it does not interact with either provider.

The current resolver registry is intentionally empty. Both official Android packages must remain draft-only until a provider-specific adapter is proven against a physical device. This tool only compares repeatable accessibility header signals; it does **not** extract or prove a provider-owned conversation ID. Its report always states stable_provider_conversation_id_exposed=false. A positive heuristic result is only a lead for manual investigation, not approval to register an adapter or enable native sending.

## Capture A → B → A

Requirements: a USB-connected Android phone with ChatGPT and Claude installed, Android Platform Tools (adb) on the computer, and Python 3.

For each provider separately:

1. Open a disposable conversation called **RM identity test A**.
2. Capture the accessibility hierarchy:
   `adb shell uiautomator dump --compressed /sdcard/rm-provider.xml`
   `adb pull /sdcard/rm-provider.xml chat-a1.xml`
3. Switch to a different disposable conversation called **RM identity test B**. Do not send anything. Capture chat-b.xml using the same two commands.
4. Return to conversation A without sending anything. Capture chat-a2.xml.
5. Analyse the three captures. ChatGPT:
   `python android-companion/scripts/provider-conversation-probe.py --package com.openai.chatgpt --delete-inputs chat-a1.xml chat-b.xml chat-a2.xml`
   Claude:
   `python android-companion/scripts/provider-conversation-probe.py --package com.anthropic.claude --delete-inputs chat-a1.xml chat-b.xml chat-a2.xml`

The --delete-inputs option removes all three local XML captures even when analysis fails. The probe accepts UTF-8 UIAutomator XML only, rejects NUL-bearing UTF-16/UTF-32 payloads, DTD/entity declarations and files over 8 MB, and prints no raw text or accessibility labels. The probe also uses a fresh random HMAC key in memory for each run, prints no raw text or accessibility labels, and does not upload data. Keep the XML captures local and use only disposable test chats.

## What the report means

- composer_control_reused_a_to_b: whether the same composer structural signature appeared in both conversations.
- send_control_reused_a_to_b: whether the same Send-control structural signature appeared in both conversations.
- a1_a2_header_similarity: repeatability of non-editable accessibility labels in the top header region after returning to A.
- a1_b_header_similarity: how much those same header signals overlap with B.
- repeatable_distinct_header_signal: a heuristic candidate signal only.

A candidate signal does **not** prove a stable provider conversation identifier. Titles and accessibility descriptions can be renamed, duplicated, localized, or reused. Before an adapter is accepted, identify a provider-owned stable thread identifier in the accessibility surface (or another supported, documented source), demonstrate it remains identical for A1/A2 and differs for B, and verify that it is not merely a title, composer, Send control, window ID, app ID, or content-derived guess.

## Acceptance rules

| Provider | Required A1/A2 result | Required A/B result | Sending |
|---|---|---|---|
| ChatGPT (com.openai.chatgpt) | Exact provider identifier repeats | Exact provider identifier differs | Disabled throughout |
| Claude (com.anthropic.claude) | Exact provider identifier repeats | Exact provider identifier differs | Disabled throughout |

If the accessibility surface exposes no suitable stable ID, record **not exposed / draft-only**. Do not infer identity from matching composer/Send nodes or from conversation titles. Do not add an adapter based only on a positive heuristic report.

## Evidence to record

Record the phone model, Android version, provider app version, capture date, whether composer and Send controls were reused, the probe's numeric similarity scores, and the final finding (verified stable ID / not exposed / inconclusive). Do not record conversation contents, titles, account information, screenshots containing private chats, raw XML, or raw provider IDs in an issue or PR.
