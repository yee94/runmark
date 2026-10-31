#!/usr/bin/env python3
"""patch_opencode_config 单元测试（stdlib unittest）。"""

from __future__ import annotations

import os
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from patch_opencode_config import (  # noqa: E402
    patch_opencode_config,
    remove_opencode_plugin,
)

SPEC = "@runmarks/opencode-plugin@0.2.10"
SPEC_OLD = "@runmarks/opencode-plugin@0.2.3"
LEGACY = "@runmarks/agent-tracker-opencode-plugin@0.2.9"


class PatchOpencodeConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_create_skeleton_when_missing(self) -> None:
        path = self.dir / "opencode.jsonc"
        msg = patch_opencode_config(path, SPEC)
        self.assertIn("已创建", msg)
        text = path.read_text()
        self.assertIn(SPEC, text)
        self.assertIn("$schema", text)
        self.assertEqual(json.loads(text)["plugins"], [SPEC])

    def test_bump_version_preserves_other_plugins_and_comments(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text(
            "{\n"
            '  "model": "x",\n'
            '  "plugin": [\n'
            '    "opencode-wakatime@1.3.8",\n'
            f'    "{SPEC_OLD}",\n'
            "    // keep me\n"
            '    "oh-my-openagent"\n'
            "  ],\n"
            '  "lsp": true,\n'
            "}\n",
            encoding="utf-8",
        )
        msg = patch_opencode_config(path, SPEC)
        self.assertIn("->", msg)
        text = path.read_text()
        self.assertIn(SPEC, text)
        self.assertNotIn(SPEC_OLD, text)
        self.assertIn("opencode-wakatime@1.3.8", text)
        self.assertIn("// keep me", text)
        self.assertIn('"model": "x"', text)
        self.assertIn('"lsp": true', text)

    def test_insert_into_existing_plugin_array(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text(
            "{\n"
            '  "plugin": [\n'
            '    "oh-my-openagent"\n'
            "  ]\n"
            "}\n",
            encoding="utf-8",
        )
        msg = patch_opencode_config(path, SPEC)
        self.assertIn("plugin 数组", msg)
        text = path.read_text()
        self.assertIn(SPEC, text)
        self.assertIn("oh-my-openagent", text)
        # 其它内容仍在
        self.assertTrue(text.strip().startswith("{"))

    def test_empty_plugin_array(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text('{\n  "plugin": []\n}\n', encoding="utf-8")
        patch_opencode_config(path, SPEC)
        text = path.read_text()
        self.assertIn(SPEC, text)

    def test_append_plugin_key_when_missing(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text(
            "{\n"
            '  "model": "imate/deepseek-v4-pro",\n'
            '  "autoupdate": false\n'
            "}\n",
            encoding="utf-8",
        )
        msg = patch_opencode_config(path, SPEC)
        self.assertIn("追加 plugin", msg)
        text = path.read_text()
        self.assertIn(SPEC, text)
        self.assertIn("imate/deepseek-v4-pro", text)
        self.assertIn('"autoupdate": false', text)

    def test_idempotent(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text(f'{{"plugin":["{SPEC}"]}}\n', encoding="utf-8")
        msg = patch_opencode_config(path, SPEC)
        self.assertIn("已是", msg)

    def test_follows_symlink_without_replacing_link(self) -> None:
        real = self.dir / "real.jsonc"
        link = self.dir / "opencode.jsonc"
        real.write_text(
            "{\n"
            '  "plugin": [\n'
            f'    "{SPEC_OLD}"\n'
            "  ]\n"
            "}\n",
            encoding="utf-8",
        )
        os.symlink(real, link)
        patch_opencode_config(link, SPEC)
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), str(real))
        self.assertIn(SPEC, real.read_text())
        self.assertNotIn(SPEC_OLD, real.read_text())

    def test_remove_plugin_preserves_others(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text(
            "{\n"
            '  "plugin": [\n'
            '    "keep-a",\n'
            f'    "{SPEC}",\n'
            '    "keep-b"\n'
            "  ]\n"
            "}\n",
            encoding="utf-8",
        )
        msg = remove_opencode_plugin(path)
        self.assertIn("移除", msg)
        text = path.read_text()
        self.assertNotIn("runmark-opencode-plugin", text)
        self.assertIn("keep-a", text)
        self.assertIn("keep-b", text)

    def test_migrate_v2_object_and_deduplicate_legacy(self) -> None:
        path = self.dir / "opencode.jsonc"
        path.write_text(json.dumps({
            "plugins": ["keep-a", {"package": LEGACY, "options": {"enabled": True}}, SPEC_OLD, "keep-b"],
            "plugin": [LEGACY],
        }))
        patch_opencode_config(path, SPEC)
        data = json.loads(path.read_text())
        self.assertEqual(data["plugins"], ["keep-a", {"package": SPEC, "options": {"enabled": True}}, "keep-b"])
        self.assertEqual(data["plugin"], [])
        self.assertIn("已是", patch_opencode_config(path, SPEC))
        remove_opencode_plugin(path)
        self.assertEqual(json.loads(path.read_text())["plugins"], ["keep-a", "keep-b"])

    def test_package_names_in_comments_and_other_fields_are_preserved(self) -> None:
        path = self.dir / "opencode.jsonc"
        comment = f'// "plugins": ["{LEGACY}"], {{}}'
        path.write_text(f'{{\n{comment}\n"note":"{LEGACY}","plugins":["keep"]\n}}')
        patch_opencode_config(path, SPEC)
        text = path.read_text()
        self.assertIn(comment, text)
        self.assertIn(f'"note":"{LEGACY}"', text)
        self.assertEqual(text.count(SPEC), 1)

    def test_remove_inline_entries_keeps_separators(self) -> None:
        path = self.dir / "opencode.jsonc"
        for entries in [[LEGACY, "a", "b"], ["a", LEGACY, "b"], ["a", "b", LEGACY], ["a", LEGACY, SPEC], [LEGACY, SPEC], [SPEC]]:
            path.write_text(json.dumps({"plugins": entries}))
            remove_opencode_plugin(path)
            self.assertEqual(json.loads(path.read_text())["plugins"], [e for e in entries if e not in (LEGACY, SPEC)])

    def test_migration_follows_symlink(self) -> None:
        real = self.dir / "real.jsonc"
        link = self.dir / "opencode.jsonc"
        real.write_text(json.dumps({"plugin": [LEGACY, "keep"]}))
        link.symlink_to(real)
        patch_opencode_config(link, SPEC)
        self.assertTrue(link.is_symlink())
        self.assertEqual(json.loads(real.read_text())["plugin"], [SPEC, "keep"])


if __name__ == "__main__":
    unittest.main()
