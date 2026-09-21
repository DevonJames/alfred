#!/usr/bin/env python3
"""Channel-map tests — no I2C. Run: python3 deploy/head-stick.test.py"""
from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("head_stick", HERE / "head-stick.py")
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ChannelMapTests(unittest.TestCase):
    def test_cli_defaults_match_alfred_home(self):
        self.assertEqual(mod.CLI_CHANNELS["body"]["ch"], 0)
        self.assertEqual(mod.CLI_CHANNELS["neck"]["ch"], 1)
        self.assertEqual(mod.CLI_CHANNELS["tilt"]["ch"], 2)
        self.assertEqual(mod.CLI_CHANNELS["roll"]["ch"], 3)

    def test_dropin_overlays_live_pi_centers(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "92-centers.conf").write_text(
                "[Service]\n"
                "Environment=ALFRED_TRACK_NECK_US_MIN=150\n"
                "Environment=ALFRED_TRACK_NECK_US_MAX=1750\n"
                "Environment=ALFRED_TRACK_NECK_CENTER_ANGLE=90.2\n"
                "Environment=ALFRED_TRACK_TILT_CENTER_ANGLE=10.0\n"
                "Environment=ALFRED_TRACK_ROLL_CENTER_ANGLE=70.0\n",
                encoding="utf8",
            )
            channels = mod.resolve_channels(tmp, environ={})
        self.assertEqual(channels["neck"]["ch"], 1)
        self.assertEqual(channels["neck"]["us"], (150, 1750))
        self.assertEqual(channels["neck"]["center"], 90.2)
        self.assertEqual(channels["tilt"]["center"], 10.0)
        self.assertEqual(channels["roll"]["center"], 70.0)
        self.assertEqual(channels["tilt"]["ch"], 2)
        self.assertEqual(channels["roll"]["ch"], 3)
        self.assertEqual(channels["tilt"]["extra_down"], 55.0)
        self.assertLess(mod.axis_floor(channels["tilt"]), float(channels["tilt"]["min"]))
        rest = mod.pulse_us_for_angle(channels["tilt"], float(channels["tilt"]["center"]))
        down = mod.pulse_us_for_angle(channels["tilt"], mod.axis_floor(channels["tilt"]))
        self.assertLess(down, rest)

    def test_probe_missing_bus_reports_absent(self):
        old = os.environ.get("ALFREDBOT_I2C_DEV")
        os.environ["ALFREDBOT_I2C_DEV"] = "/dev/i2c-does-not-exist"
        try:
            result = mod.probe_bus()
        finally:
            if old is None:
                os.environ.pop("ALFREDBOT_I2C_DEV", None)
            else:
                os.environ["ALFREDBOT_I2C_DEV"] = old
        self.assertFalse(result["present"])
        self.assertEqual(result["acks"], [])
        self.assertTrue(result["error"])


if __name__ == "__main__":
    raise SystemExit(unittest.main())
