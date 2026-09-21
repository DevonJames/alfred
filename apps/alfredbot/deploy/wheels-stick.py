#!/usr/bin/env python3
"""Write MDDS30 tank-drive bytes. Protocol matches alfred-home alfred_cli.py.

Left motor 0x00, right 0x80, bit 6 = reverse, bits 0–5 = speed 0–63.
Host encodes analog sticks; this helper only opens /dev/serial0 and writes.
"""
from __future__ import annotations

import json
import os
import sys

PORT = os.environ.get("ALFRED_MDDS30_SERIAL_PORT", "/dev/serial0")
BAUD = int(os.environ.get("ALFRED_MDDS30_BAUDRATE", "9600"))


def write_bytes(left: int, right: int) -> None:
    try:
        import serial  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"pyserial unavailable: {exc}") from exc
    with serial.Serial(
        PORT,
        baudrate=BAUD,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=0,
        write_timeout=1,
    ) as motor:
        motor.write(bytes([left & 0xFF, right & 0xFF]))
        motor.flush()


def handle(msg: dict) -> dict:
    cmd = msg.get("cmd")
    if cmd != "write":
        return {"ok": False, "error": f"unknown cmd {cmd}"}
    try:
        left = int(msg.get("left", 0))
        right = int(msg.get("right", 0x80))
    except (TypeError, ValueError):
        return {"ok": False, "error": "left/right must be ints"}
    if os.environ.get("ALFREDBOT_WHEELS_MOCK") == "1":
        return {"ok": True, "left": left, "right": right, "mock": True}
    write_bytes(left, right)
    return {"ok": True, "left": left, "right": right}


def serve() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
            continue
        try:
            print(json.dumps(handle(msg)), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        raise SystemExit(serve())
    print("usage: wheels-stick.py serve", file=sys.stderr)
    raise SystemExit(2)
