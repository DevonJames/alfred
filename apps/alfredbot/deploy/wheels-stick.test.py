#!/usr/bin/env python3
"""Wheel helper tests — no serial. Run: python3 deploy/wheels-stick.test.py"""
from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("wheels_stick", HERE / "wheels-stick.py")
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class HandleTests(unittest.TestCase):
    def test_mock_write_echoes_bytes(self):
        os.environ["ALFREDBOT_WHEELS_MOCK"] = "1"
        result = mod.handle({"cmd": "write", "left": 40, "right": 0x80 | 40})
        self.assertTrue(result["ok"])
        self.assertEqual(result["left"], 40)
        self.assertEqual(result["right"], 0xA8)

    def test_rejects_unknown_cmd(self):
        self.assertFalse(mod.handle({"cmd": "spin"})["ok"])


if __name__ == "__main__":
    unittest.main()
