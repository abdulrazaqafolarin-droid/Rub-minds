#!/usr/bin/env python3
"""Private stdio bridge for Rub Minds' CUA virtual execution workspaces.

The bridge owns only sandboxes it creates. It never exposes a guest port to the
browser and never accepts arbitrary host commands.
"""
import asyncio
import base64
import json
import re
import sys
import uuid

try:
    from cua_sandbox import Image, Sandbox
except Exception as exc:
    Image = Sandbox = None
    IMPORT_ERROR = str(exc)
else:
    IMPORT_ERROR = None

SESSIONS = {}
ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
PACKAGE_RE = re.compile(r"^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$")
ANDROID_KEYS = {"enter": 66, "back": 4, "home": 3, "delete": 67, "tab": 61, "escape": 111, "menu": 82}
DESKTOP_APPS = {
    "browser": "chromium",
    "firefox": "firefox",
    "terminal": "xfce4-terminal --disable-server --maximize",
    "files": "thunar",
    "text-editor": "mousepad",
    "office": "libreoffice",
    "calculator": "galculator",
}
TOOL_DEFS = [
    {"name": "session_start", "description": "Create a dedicated local Android or Linux virtual machine for one Backroom group and AI session.", "inputSchema": {"type": "object", "properties": {"surface": {"type": "string", "enum": ["android", "desktop", "terminal"]}, "groupId": {"type": "string"}, "sessionId": {"type": "string"}}, "required": ["surface", "groupId", "sessionId"]}},
    {"name": "session_snapshot", "description": "Capture a bounded JPEG screenshot and dimensions from an owned virtual session.", "inputSchema": {"type": "object", "properties": {"surface": {"type": "string"}, "groupId": {"type": "string"}, "sessionId": {"type": "string"}}, "required": ["surface", "groupId", "sessionId"]}},
    {"name": "session_apps", "description": "List installed third-party Android packages or supported desktop launch targets in an owned virtual session.", "inputSchema": {"type": "object", "properties": {"surface": {"type": "string"}, "groupId": {"type": "string"}, "sessionId": {"type": "string"}}, "required": ["surface", "groupId", "sessionId"]}},
    {"name": "session_launch", "description": "Launch one installed Android package or allowlisted Linux desktop application in an owned virtual session.", "inputSchema": {"type": "object", "properties": {"surface": {"type": "string"}, "groupId": {"type": "string"}, "sessionId": {"type": "string"}, "app": {"type": "string"}}, "required": ["surface", "groupId", "sessionId", "app"]}},
    {"name": "session_input", "description": "Send a bounded tap, swipe, drag, scroll, key or text input into an owned virtual session. Coordinates are normalized 0..1.", "inputSchema": {"type": "object", "properties": {"surface": {"type": "string"}, "groupId": {"type": "string"}, "sessionId": {"type": "string"}, "action": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "x2": {"type": "number"}, "y2": {"type": "number"}, "text": {"type": "string"}, "key": {"type": "string"}, "dx": {"type": "integer"}, "dy": {"type": "integer"}}, "required": ["surface", "groupId", "sessionId", "action"]}},
    {"name": "session_close", "description": "Destroy an owned virtual session and its VM.", "inputSchema": {"type": "object", "properties": {"surface": {"type": "string"}, "groupId": {"type": "string"}, "sessionId": {"type": "string"}}, "required": ["surface", "groupId", "sessionId"]}},
]

def _scope(args):
    surface, group_id, session_id = args.get("surface"), args.get("groupId"), args.get("sessionId")
    if surface not in ("android", "desktop", "terminal") or not isinstance(group_id, str) or not ID_RE.fullmatch(group_id) or not isinstance(session_id, str) or not ID_RE.fullmatch(session_id):
        raise ValueError("invalid_virtual_session_scope")
    return (group_id, session_id, surface)

def _get(args):
    key = _scope(args)
    row = SESSIONS.get(key)
    if not row:
        raise ValueError("virtual_session_not_found")
    return row

async def _create(args):
    if IMPORT_ERROR:
        raise RuntimeError("cua_sandbox Python package is unavailable; install the Backroom virtual-runtime requirements")
    key = _scope(args)
    if key in SESSIONS:
        row = SESSIONS[key]
        info = await row["sandbox"].info()
        return {"state": "ready", "surface": key[2], "sandboxName": row["name"], "sandboxId": row["sandbox"].id, "info": {"kind": info.kind, "runtime": info.runtime}}
    name = "rm-vexec-" + key[2] + "-" + uuid.uuid4().hex[:10]
    if key[2] == "android":
        image = Image.android(version="14")
        sandbox = await Sandbox.create(image, name=name, on="local", kind="vm", runtime="qemu", cpu=4, memory_mb=4096, disk_gb=16, request_timeout=900)
    else:
        image = Image.linux(kind="vm")
        sandbox = await Sandbox.create(image, name=name, on="local", kind="vm", runtime="qemu", cpu=4, memory_mb=4096, disk_gb=24, wait_for="desktop", request_timeout=900)
        if key[2] == "terminal":
            launch = await sandbox.shell.run("nohup xfce4-terminal --disable-server --maximize >/tmp/rub-minds-terminal.log 2>&1 </dev/null &", timeout=15)
            if launch.returncode != 0:
                await sandbox.destroy()
                raise RuntimeError("virtual_terminal_launch_failed")
    SESSIONS[key] = {"sandbox": sandbox, "name": name, "surface": key[2]}
    return {"state": "ready", "surface": key[2], "sandboxName": name, "sandboxId": sandbox.id, "isolation": "dedicated local QEMU virtual machine"}

async def _snapshot(args):
    row = _get(args)
    sandbox = row["sandbox"]
    width, height = await sandbox.get_dimensions()
    content = await sandbox.screenshot(format="jpeg", quality=68)
    if len(content) > 1_400_000:
        content = await sandbox.screenshot(format="jpeg", quality=48)
    if len(content) > 1_400_000:
        raise RuntimeError("virtual_screenshot_exceeds_limit")
    title = ""
    try:
        title = await sandbox.window.get_active_title()
    except Exception:
        pass
    return {"surface": row["surface"], "sandboxName": row["name"], "width": int(width), "height": int(height), "mimeType": "image/jpeg", "imageBase64": base64.b64encode(content).decode("ascii"), "activeTitle": str(title)[:200]}

async def _apps(args):
    row = _get(args)
    sandbox = row["sandbox"]
    if row["surface"] == "android":
        result = await sandbox.shell.run("pm list packages -3", timeout=20)
        if result.returncode != 0:
            raise RuntimeError("android_package_inventory_unavailable")
        packages = []
        for line in result.stdout.splitlines():
            value = line.strip().removeprefix("package:")
            if PACKAGE_RE.fullmatch(value):
                packages.append(value)
        return {"surface": "android", "apps": sorted(set(packages)), "source": "virtual_device_package_manager"}
    return {"surface": row["surface"], "apps": [{"id": app_id, "command": command} for app_id, command in DESKTOP_APPS.items()], "source": "allowlisted_virtual_desktop_launchers"}

async def _launch(args):
    row = _get(args)
    app = args.get("app")
    if not isinstance(app, str) or len(app) > 180:
        raise ValueError("invalid_virtual_app")
    sandbox = row["sandbox"]
    if row["surface"] == "android":
        if not PACKAGE_RE.fullmatch(app):
            raise ValueError("invalid_android_package")
        check = await sandbox.shell.run("pm list packages " + app, timeout=15)
        if check.returncode != 0 or ("package:" + app) not in check.stdout.splitlines():
            raise ValueError("android_app_not_installed_in_virtual_device")
        result = await sandbox.shell.run("monkey -p " + app + " 1", timeout=20)
        if result.returncode != 0:
            raise RuntimeError("android_app_launch_failed")
    else:
        command = DESKTOP_APPS.get(app)
        if not command:
            raise ValueError("desktop_app_not_allowlisted")
        result = await sandbox.shell.run("nohup " + command + " >/tmp/rub-minds-app.log 2>&1 </dev/null &", timeout=15)
        if result.returncode != 0:
            raise RuntimeError("desktop_app_launch_failed")
    return {"state": "launched", "surface": row["surface"], "app": app, "inVirtualMachine": True}

def _point(args, key, size):
    value = args.get(key)
    if not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise ValueError("normalized_coordinates_must_be_between_0_and_1")
    return max(0, min(size - 1, round(value * (size - 1))))

async def _input(args):
    row = _get(args)
    sandbox = row["sandbox"]
    action = args.get("action")
    if action not in {"tap", "double_tap", "long_press", "swipe", "drag", "scroll", "type", "key", "home", "back", "recents"}:
        raise ValueError("unsupported_virtual_input")
    width, height = await sandbox.get_dimensions()
    android = row["surface"] == "android"
    if action in {"tap", "double_tap", "long_press", "swipe", "drag", "scroll"}:
        x, y = _point(args, "x", width), _point(args, "y", height)
    if action in {"swipe", "drag"}:
        x2, y2 = _point(args, "x2", width), _point(args, "y2", height)
    if action == "tap":
        await (sandbox.mobile.tap(x, y) if android else sandbox.mouse.click(x, y))
    elif action == "double_tap":
        await (sandbox.mobile.double_tap(x, y) if android else sandbox.mouse.double_click(x, y))
    elif action == "long_press":
        if android:
            await sandbox.mobile.long_press(x, y, duration_ms=650)
        else:
            await sandbox.mouse.mouse_down(x, y)
            await asyncio.sleep(0.65)
            await sandbox.mouse.mouse_up(x, y)
    elif action in {"swipe", "drag"}:
        if android:
            await sandbox.mobile.swipe(x, y, x2, y2, duration_ms=350)
        else:
            await sandbox.mouse.drag(x, y, x2, y2)
    elif action == "scroll":
        dx, dy = args.get("dx", 0), args.get("dy", -3)
        if not isinstance(dx, int) or not isinstance(dy, int) or abs(dx) > 20 or abs(dy) > 20:
            raise ValueError("invalid_scroll_delta")
        if android:
            distance = max(120, min(1200, abs(dy) * 120))
            if dy < 0:
                await sandbox.mobile.scroll_down(x, y, distance=distance)
            else:
                await sandbox.mobile.scroll_up(x, y, distance=distance)
        else:
            await sandbox.mouse.scroll(x, y, scroll_x=dx, scroll_y=dy)
    elif action == "type":
        value = args.get("text")
        if not isinstance(value, str) or not value.strip() or len(value) > 4000 or any(ord(ch) < 32 and ch not in "\n\t" for ch in value):
            raise ValueError("invalid_virtual_text")
        await (sandbox.mobile.type_text(value) if android else sandbox.keyboard.type(value))
    elif action == "key":
        value = args.get("key")
        if not isinstance(value, str) or value.lower() not in (ANDROID_KEYS if android else {"enter": 1, "escape": 1, "tab": 1, "backspace": 1, "delete": 1, "home": 1, "end": 1, "up": 1, "down": 1, "left": 1, "right": 1, "ctrl+a": 1, "ctrl+c": 1, "ctrl+v": 1, "ctrl+z": 1, "ctrl+shift+s": 1}):
            raise ValueError("unsupported_virtual_key")
        if android:
            await sandbox.mobile.key(ANDROID_KEYS[value.lower()])
        else:
            await sandbox.keyboard.keypress(value.lower())
    elif action == "home":
        if not android:
            raise ValueError("android_navigation_key_only")
        await sandbox.mobile.home()
    elif action == "back":
        if not android:
            raise ValueError("android_navigation_key_only")
        await sandbox.mobile.back()
    elif action == "recents":
        if not android:
            raise ValueError("android_navigation_key_only")
        await sandbox.mobile.recents()
    return {"state": "input_dispatched", "action": action, "surface": row["surface"]}

async def _close(args):
    key = _scope(args)
    row = SESSIONS.pop(key, None)
    if not row:
        return {"closed": False, "state": "not_found"}
    await row["sandbox"].destroy()
    return {"closed": True, "state": "destroyed", "sandboxName": row["name"]}

async def _call(name, args):
    if name == "session_start":
        return await _create(args)
    if name == "session_snapshot":
        return await _snapshot(args)
    if name == "session_apps":
        return await _apps(args)
    if name == "session_launch":
        return await _launch(args)
    if name == "session_input":
        return await _input(args)
    if name == "session_close":
        return await _close(args)
    raise ValueError("unknown_virtual_runtime_tool")

async def _dispatch(message):
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "rub-minds-cua-virtual-runtime", "version": "1.0.0"}}
    elif method == "notifications/initialized":
        return None
    elif method == "tools/list":
        result = {"tools": TOOL_DEFS}
    elif method == "tools/call":
        try:
            output = await _call(params.get("name"), params.get("arguments") or {})
            result = {"content": [{"type": "text", "text": json.dumps(output, separators=(",", ":"))}]}
        except Exception as exc:
            result = {"isError": True, "content": [{"type": "text", "text": str(exc)[:300]}]}
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method_not_found"}}
    if request_id is None:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "result": result}

async def _serve():
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                continue
            response = await _dispatch(request)
            if response is not None:
                sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
                sys.stdout.flush()
        except Exception as exc:
            sys.stderr.write("Backroom CUA virtual runtime: " + str(exc)[:200] + "\n")
            sys.stderr.flush()

async def _cleanup():
    for row in list(SESSIONS.values()):
        try:
            await row["sandbox"].destroy()
        except Exception:
            pass
    SESSIONS.clear()

if __name__ == "__main__":
    try:
        asyncio.run(_serve())
    finally:
        try:
            asyncio.run(_cleanup())
        except Exception:
            pass
