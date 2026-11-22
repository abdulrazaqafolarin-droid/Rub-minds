# Backroom device-frame experience

Status: implementation direction for the authenticated Backroom workspace.

## Product surface

Backroom is a device-frame workspace, not a simulator. It must show the original screen of a paired device after that device grants the operating-system screen-sharing request. It must not draw a fake provider screen, invent app activity, claim to virtualize an Android app, or create UI-only device records.

The Backroom route has one authenticated workspace. It opens the device frames directly; there is no separate simulator or browser-runtime workspace in the user navigation.

## Layout and navigation

- The group selector scopes the device inventory, activity history, pairing, approvals and device controls.
- The device-connections panel shows paired devices, platform, owner-only approve/revoke controls, an **Approved / Pending approval / Revoked** enrollment label, and the last authenticated heartbeat time. "Approved" is not presented as "Online"; the live phone/computer controller reports the current channel and stream state separately.
- The primary stage switches between **Android phone** and **Computer**. Each stage contains a real runtime controller.
- The phone frame streams the original selected Android app from the paired phone. App selection, connection state and stream controls sit beside the stream rather than inside a decorative nested phone.
- The computer frame shows the actual paired computer's approved screen session. Its terminal is a mode within that computer frame, not a separate simulated device.
- Desktop input is available only when the selected app was launched by Backroom, its unique native foreground HWND/process identity is verified by Windows UI Automation, and that exact window fills the shared monitor bounds. Browser-selected single-window capture remains view-only because the browser picker does not disclose the native HWND. If the identity or geometry cannot be proven, the real screen may remain visible but input is disabled.
- Empty states explain how to pair the missing runtime and give the group owner a direct pairing action.
- A quiet refresh timestamp and a 20-second visible-tab refresh keep presence and activity current. Responses from an old room or older refresh cannot replace the current room's state.
- On small screens, the live frame appears before device management details; controls stack below the live screen rather than shrinking it into a mock device.

## Permission boundaries

Device identity and screen visibility do not authorize control. Screen share, touch, draft insertion and native Send remain separately authorized operations.

A composer selection identifies one real editable non-password target. Draft insertion remains explicitly unsent. A visible or discoverable Send control is evidence only, not permission to activate it.

Native Off / On / Auto is unavailable until the exact provider conversation can be resolved and revalidated on the device, its identity is bound to the intended Rub Minds AI/session, the server/device forwarder is deployed to an isolated Staging environment, and the physical-device acceptance cases pass. Package name, screen title, composer hash and app signer are not substitutes for provider-conversation identity.

## Frame acceptance

1. A human opens Backroom for a group and sees only that group's actual paired device inventory.
2. The group owner can pair, approve or revoke a device; non-owners cannot perform owner actions.
3. Selecting an Android phone shows its actual app stream after the phone's operating-system permission flow. A disconnected or hidden app is shown as unavailable, not fabricated.
4. Touch requires a separate temporary device-local permission. Draft insertion requires a separate approval and never submits the draft.
5. Selecting a computer shows the actual approved computer screen; its terminal controls stay inside that computer frame. Computer input requires an exact Backroom-launched app HWND/process identity and matching full-monitor bounds; otherwise the frame is view-only.
6. Switching groups or devices clears stale frame/selection state. A late response from an old group cannot replace the newly selected group's data.
7. Revocation, expiry, disconnect and uncertain outcomes have explicit status and recovery messages. A transient desktop WebRTC `disconnected` state gets a 20-second reconnect window; `failed` or `closed` stops the session immediately. Android uses its own bounded reconnect and screen-source visibility handling.
8. A missing provider-conversation resolver never enables native Send or autonomous Off / On / Auto.
