#!/usr/bin/env python3
"""Drive AlfredBot's head servos from the iPhone sticks.

Channel map matches alfred-home `robot-client/sensors/alfred_cli.py` and
`face_tracker.py`:

  Ch 0 body pivot   (not used on this slice)
  Ch 1 neck pan
  Ch 2 head tilt (pitch)
  Ch 3 head roll (ear-to-shoulder)

Pulse ranges and rest angles start from the CLI table, then overlay the
face-tracker systemd drop-ins on the Pi so we do not snap the neck to a
stale 27° after the rig was re-centered.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, Optional

PAUSE_PATH = os.environ.get("ALFRED_TRACK_PAUSE_PATH", "/tmp/alfred-tracker-pause.json")
STATE_PATH = os.environ.get("ALFRED_TRACK_STATE_PATH", "/tmp/alfred-tracker.json")
MODE_PATH = os.environ.get("ALFRED_CLI_MODE_PATH", "/tmp/alfred-cli-mode.json")
POSE_PATH = os.environ.get("ALFRED_CLI_POSE_PATH", "/tmp/alfred-cli-pose.json")
TRACKER_DROPIN_DIR = os.environ.get(
    "ALFRED_TRACKER_DROPIN_DIR",
    "/etc/systemd/system/alfred-face-tracker.service.d",
)
FOREVER_S = 10 * 365 * 24 * 3600
TRACKER_RELEASE_S = 0.15

# Source of truth for *which* PCA9685 channel is which joint.
# Pulse/center numbers are the CLI defaults; live Pi drop-ins overlay them.
CLI_CHANNELS: Dict[str, Dict[str, object]] = {
    "body": {"ch": 0, "us": (450, 1750), "min": 10.0, "max": 170.0, "center": 90.0},
    "neck": {"ch": 1, "us": (350, 1350), "min": 5.0, "max": 175.0, "center": 27.0},
    "tilt": {"ch": 2, "us": (650, 1300), "min": 5.0, "max": 175.0, "center": 90.0},
    "roll": {"ch": 3, "us": (400, 1100), "min": 10.0, "max": 170.0, "center": 90.0},
}

ENV_KEYS = {
    "body": {
        "ch": "ALFRED_TRACK_BODY_CH",
        "us_min": "ALFRED_TRACK_BODY_US_MIN",
        "us_max": "ALFRED_TRACK_BODY_US_MAX",
        "min": "ALFRED_TRACK_BODY_ANGLE_MIN",
        "max": "ALFRED_TRACK_BODY_ANGLE_MAX",
        "center": "ALFRED_TRACK_BODY_CENTER_ANGLE",
    },
    "tilt": {
        "ch": "ALFRED_TRACK_TILT_CH",
        "us_min": "ALFRED_TRACK_TILT_US_MIN",
        "us_max": "ALFRED_TRACK_TILT_US_MAX",
        "min": "ALFRED_TRACK_TILT_ANGLE_MIN",
        "max": "ALFRED_TRACK_TILT_ANGLE_MAX",
        "center": "ALFRED_TRACK_TILT_CENTER_ANGLE",
    },
    "neck": {
        "ch": "ALFRED_TRACK_NECK_CH",
        "us_min": "ALFRED_TRACK_NECK_US_MIN",
        "us_max": "ALFRED_TRACK_NECK_US_MAX",
        "min": "ALFRED_TRACK_NECK_ANGLE_MIN",
        "max": "ALFRED_TRACK_NECK_ANGLE_MAX",
        "center": "ALFRED_TRACK_NECK_CENTER_ANGLE",
    },
    "roll": {
        "ch": "ALFRED_TRACK_ROLL_CH",
        "us_min": "ALFRED_TRACK_ROLL_US_MIN",
        "us_max": "ALFRED_TRACK_ROLL_US_MAX",
        "min": "ALFRED_TRACK_ROLL_ANGLE_MIN",
        "max": "ALFRED_TRACK_ROLL_ANGLE_MAX",
        "center": "ALFRED_TRACK_ROLL_CENTER_ANGLE",
    },
}


def parse_tracker_dropins(directory: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if not os.path.isdir(directory):
        return env
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".conf"):
            continue
        path = os.path.join(directory, name)
        try:
            with open(path, encoding="utf8") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        for raw in lines:
            line = raw.strip()
            if not line.startswith("Environment="):
                continue
            payload = line.split("=", 1)[1]
            if payload.startswith(("'", '"')) and payload.endswith(payload[0]) and len(payload) >= 2:
                payload = payload[1:-1]
            if "=" not in payload:
                continue
            key, value = payload.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def _as_int(value: object, fallback: int) -> int:
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return fallback


def _as_float(value: object, fallback: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback


def resolve_channels(
    dropin_dir: str = TRACKER_DROPIN_DIR,
    environ: Optional[Dict[str, str]] = None,
) -> Dict[str, Dict[str, object]]:
    overlay = parse_tracker_dropins(dropin_dir)
    overlay.update(environ if environ is not None else os.environ)
    channels: Dict[str, Dict[str, object]] = {}
    for axis, base in CLI_CHANNELS.items():
        keys = ENV_KEYS[axis]
        us = base["us"]
        channels[axis] = {
            "ch": _as_int(overlay.get(keys["ch"], base["ch"]), int(base["ch"])),  # type: ignore[arg-type]
            "us": (
                _as_int(overlay.get(keys["us_min"], us[0]), int(us[0])),  # type: ignore[index]
                _as_int(overlay.get(keys["us_max"], us[1]), int(us[1])),  # type: ignore[index]
            ),
            "min": _as_float(overlay.get(keys["min"], base["min"]), float(base["min"])),  # type: ignore[arg-type]
            "max": _as_float(overlay.get(keys["max"], base["max"]), float(base["max"])),  # type: ignore[arg-type]
            "center": _as_float(overlay.get(keys["center"], base["center"]), float(base["center"])),  # type: ignore[arg-type]
            "extra_down": 0.0,
        }
    return expand_remote_tilt(channels)


# Live rest is ~10° with a tracker floor of 10°, so the phone had no look-down.
# Keep the rest pulse (us/center) and allow extra travel below that floor.
REMOTE_TILT_EXTRA_DOWN_DEG = 55.0


def expand_remote_tilt(channels: Dict[str, Dict[str, object]]) -> Dict[str, Dict[str, object]]:
    tilt = channels["tilt"]
    tilt["extra_down"] = REMOTE_TILT_EXTRA_DOWN_DEG
    return channels


def axis_floor(spec: Dict[str, object]) -> float:
    return float(spec["min"]) - float(spec.get("extra_down") or 0)  # type: ignore[arg-type]


def pulse_us_for_angle(spec: Dict[str, object], angle: float) -> float:
    us_min, us_max = spec["us"]  # type: ignore[misc]
    return float(us_min) + (angle / 180.0) * (float(us_max) - float(us_min))


def write_axis(kit, spec: Dict[str, object], angle: float) -> float:
    """Drive one joint. Tilt may go below the tracker floor without moving rest."""
    lo = axis_floor(spec)
    hi = float(spec["max"])  # type: ignore[arg-type]
    clamped = max(lo, min(hi, angle))
    pulse = max(350.0, min(2500.0, pulse_us_for_angle(spec, clamped)))
    us_min, us_max = spec["us"]  # type: ignore[misc]
    span_lo = min(float(us_min), pulse)
    span_hi = max(float(us_max), pulse)
    servo = kit.servo[int(spec["ch"])]
    servo.set_pulse_width_range(int(span_lo), int(span_hi))
    if span_hi <= span_lo:
        return clamped
    servo.angle = (pulse - span_lo) / (span_hi - span_lo) * 180.0
    return clamped


CHANNELS = resolve_channels()


def _atomic_write(path: str, payload: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)


def write_pause(until_ts: float, reason: str) -> None:
    _atomic_write(PAUSE_PATH, {"until_ts": float(until_ts), "reason": reason})


def write_mode(mode: str) -> None:
    _atomic_write(MODE_PATH, {"mode": mode, "ts": time.time()})


def read_mode() -> str:
    try:
        with open(MODE_PATH, encoding="utf8") as fh:
            return str(json.load(fh).get("mode", "on"))
    except (OSError, ValueError):
        return "on"


def read_pose() -> Dict[str, float]:
    try:
        with open(POSE_PATH, encoding="utf8") as fh:
            data = json.load(fh)
        return {k: float(v) for k, v in data.items() if isinstance(v, (int, float))}
    except (OSError, ValueError):
        return {}


def write_pose(pose: Dict[str, float]) -> None:
    _atomic_write(POSE_PATH, {**pose, "ts": time.time()})


def current_angle(axis: str) -> float:
    spec = CHANNELS[axis]
    center = float(spec["center"])  # type: ignore[arg-type]
    if read_mode() == "off":
        pose = read_pose()
        if axis in pose:
            return pose[axis]
    try:
        with open(STATE_PATH, encoding="utf8") as fh:
            tracker = json.load(fh)
        value = tracker.get("angles", {}).get(axis)
        if isinstance(value, (int, float)):
            return float(value)
    except (OSError, ValueError):
        pass
    return center


def snapshot_pose() -> Dict[str, float]:
    return {axis: current_angle(axis) for axis in CHANNELS}


def pause_tracker() -> Dict[str, float]:
    """Tell the face tracker to drop the I2C bus *before* we open it."""
    pose = snapshot_pose()
    write_mode("off")
    write_pose(pose)
    write_pause(time.time() + FOREVER_S, "ios-joystick")
    time.sleep(TRACKER_RELEASE_S)
    return pose


PCA_PROBE_ADDRS = tuple(range(0x40, 0x48)) + (0x70,)
MISSING_PCA = (
    "The PCA9685 neck board isn't answering on I2C "
    "(nothing at 0x40–0x47). Face tracking is down for the same reason."
)


def describe_i2c_error(exc: Exception) -> str:
    text = str(exc)
    if "I2C device" in text or "Remote I/O" in text:
        return MISSING_PCA
    return text


def probe_bus(busno: int | None = None) -> dict:
    """ACK-scan PCA9685 addresses without opening ServoKit / Blinka."""
    import fcntl

    bus = busno if busno is not None else int(os.environ.get("ALFREDBOT_I2C_BUS", "1"))
    path = os.environ.get("ALFREDBOT_I2C_DEV", f"/dev/i2c-{bus}")
    try:
        fd = os.open(path, os.O_RDWR)
    except OSError as exc:
        return {"ok": False, "present": False, "acks": [], "bus": path, "error": str(exc)}
    acks: list[str] = []
    try:
        for addr in PCA_PROBE_ADDRS:
            try:
                fcntl.ioctl(fd, 0x0703, addr)  # I2C_SLAVE
                os.write(fd, b"\x00")
                acks.append(hex(addr))
            except OSError:
                continue
    finally:
        os.close(fd)
    present = bool(acks)
    return {"ok": True, "present": present, "acks": acks, "bus": path, "error": None if present else MISSING_PCA}


def resolve_pca_address() -> int:
    forced = os.environ.get("ALFREDBOT_PCA_ADDRESS")
    if forced:
        return int(forced, 0)
    acks = probe_bus().get("acks") or []
    for raw in acks:
        addr = int(str(raw), 0)
        if 0x40 <= addr <= 0x47:
            return addr
    if acks:
        return int(str(acks[0]), 0)
    return 0x40


def setup_kit():
    from adafruit_servokit import ServoKit  # type: ignore

    address = resolve_pca_address()
    kit = ServoKit(channels=16, address=address)
    for spec in CHANNELS.values():
        us = spec["us"]  # type: ignore[index]
        kit.servo[int(spec["ch"])].set_pulse_width_range(int(us[0]), int(us[1]))  # type: ignore[index]
    return kit


def cmd_probe() -> int:
    print(json.dumps(probe_bus()), flush=True)
    return 0


def apply_deltas(kit, neck: float, tilt: float, roll: float) -> Dict[str, object]:
    deltas = {"neck": neck, "tilt": tilt, "roll": roll}
    pose = snapshot_pose()
    write_mode("off")
    write_pause(time.time() + FOREVER_S, "ios-joystick")
    for axis, delta in deltas.items():
        spec = CHANNELS[axis]
        current = pose.get(axis, float(spec["center"]))  # type: ignore[arg-type]
        pose[axis] = write_axis(kit, spec, current + delta)
    write_pose(pose)
    return {"ok": True, "action": "apply", "pose": pose, "deltas": deltas}


def cmd_config() -> int:
    print(
        json.dumps(
            {
                "ok": True,
                "channels": {
                    axis: {
                        "ch": spec["ch"],
                        "us": list(spec["us"]),  # type: ignore[arg-type]
                        "min": spec["min"],
                        "max": spec["max"],
                        "center": spec["center"],
                        "floor": axis_floor(spec),
                    }
                    for axis, spec in CHANNELS.items()
                },
            }
        ),
        flush=True,
    )
    return 0


def cmd_engage() -> int:
    pose = pause_tracker()
    print(json.dumps({"ok": True, "action": "engage", "pose": pose}), flush=True)
    return 0


def cmd_release() -> int:
    write_mode("on")
    write_pause(0.0, "ios-joystick-release")
    try:
        os.remove(POSE_PATH)
    except OSError:
        pass
    print(json.dumps({"ok": True, "action": "release"}), flush=True)
    return 0


def cmd_apply(neck: float, tilt: float, roll: float) -> int:
    pause_tracker()
    print(json.dumps(apply_deltas(setup_kit(), neck, tilt, roll)), flush=True)
    return 0


def cmd_serve() -> int:
    """Keep PCA9685 open so analog sticks do not re-init I2C every tick."""
    kit: Optional[object] = None
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            print(json.dumps({"ok": False, "error": "bad json"}), flush=True)
            continue
        cmd = msg.get("cmd")
        try:
            if cmd == "engage":
                pose = pause_tracker()
                if kit is None:
                    kit = setup_kit()
                print(json.dumps({"ok": True, "action": "engage", "pose": pose}), flush=True)
            elif cmd == "apply":
                if kit is None:
                    pause_tracker()
                    kit = setup_kit()
                print(
                    json.dumps(
                        apply_deltas(
                            kit,
                            float(msg.get("neck", 0.0) or 0.0),
                            float(msg.get("tilt", 0.0) or 0.0),
                            float(msg.get("roll", 0.0) or 0.0),
                        )
                    ),
                    flush=True,
                )
            elif cmd in {"release", "quit"}:
                return cmd_release()
            elif cmd == "config":
                cmd_config()
            elif cmd == "probe":
                cmd_probe()
            else:
                print(json.dumps({"ok": False, "error": f"unknown cmd {cmd}"}), flush=True)
        except Exception as exc:  # noqa: BLE001 — surface I2C failures to the host
            print(json.dumps({"ok": False, "error": describe_i2c_error(exc)}), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("engage")
    sub.add_parser("release")
    sub.add_parser("serve")
    sub.add_parser("config")
    sub.add_parser("probe")
    apply_p = sub.add_parser("apply")
    apply_p.add_argument("--neck-deg", type=float, default=0.0)
    apply_p.add_argument("--tilt-deg", type=float, default=0.0)
    apply_p.add_argument("--roll-deg", type=float, default=0.0)
    args = parser.parse_args()
    if args.cmd == "engage":
        return cmd_engage()
    if args.cmd == "release":
        return cmd_release()
    if args.cmd == "serve":
        return cmd_serve()
    if args.cmd == "config":
        return cmd_config()
    if args.cmd == "probe":
        return cmd_probe()
    return cmd_apply(args.neck_deg, args.tilt_deg, args.roll_deg)


if __name__ == "__main__":
    raise SystemExit(main())
