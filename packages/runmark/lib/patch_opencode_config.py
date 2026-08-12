#!/usr/bin/env python3
"""原地 patch opencode.jsonc：只改 agent-tracker 插件条目，禁止整文件覆写。

约束：
- 已有配置必须文本级 patch（保留注释、尾逗号、其它 plugin、其它顶层字段）
- 跟随 symlink 写入目标文件，不得用临时文件 mv 替换路径（否则会拆掉 Mackup 等 symlink）
- 仅当配置文件不存在时，才创建最小骨架
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

PLUGIN_BASE = "@runmarks/opencode-plugin"
PLUGIN_PAT = re.compile(
    r"@runmarks/opencode-plugin(?:@[^\"'\s,\]]+)?"
)
PLUGIN_ARRAY_PAT = re.compile(r'("plugin"\s*:\s*)\[', re.MULTILINE)
EMPTY_PLUGIN_ARRAY_PAT = re.compile(
    r'("plugin"\s*:\s*)\[\s*\]',
    re.MULTILINE,
)


def _write_inplace(path: pathlib.Path, text: str) -> None:
    """跟随 symlink 原地写入，避免替换路径本身。"""
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


def _insert_into_plugin_array(text: str, plugin_spec: str) -> str | None:
    """在已有 plugin 数组开头插入条目；空数组则替换为单元素数组。"""
    empty = EMPTY_PLUGIN_ARRAY_PAT.search(text)
    if empty:
        return (
            text[: empty.start()]
            + empty.group(1)
            + f'[\n    "{plugin_spec}"\n  ]'
            + text[empty.end() :]
        )

    m = PLUGIN_ARRAY_PAT.search(text)
    if not m:
        return None
    # 非空数组：紧跟 [ 后插入一行
    insert_at = m.end()
    return text[:insert_at] + f'\n    "{plugin_spec}",' + text[insert_at:]


def _insert_plugin_key(text: str, plugin_spec: str) -> str | None:
    """配置里没有 plugin 字段时，在顶层对象末尾追加，不碰其它键。"""
    # 从末尾找与首个 { 匹配的 }，在其前插入
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    end = -1
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return None

    before = text[:end].rstrip()
    # 若最后一个非空白不是 { 或 ,，补一个逗号
    if before and before[-1] not in "{,":
        before += ","
    block = f'\n  "plugin": [\n    "{plugin_spec}"\n  ]\n'
    return before + block + text[end:]


def patch_opencode_config(path: pathlib.Path, plugin_spec: str) -> str:
    """
    patch 或创建 opencode.jsonc。
    返回人类可读状态行（OK: / WARN:）。
    """
    if not plugin_spec.startswith(PLUGIN_BASE):
        raise SystemExit(f"invalid plugin spec: {plugin_spec}")

    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        skeleton = (
            "{\n"
            '  "$schema": "https://opencode.ai/config.json",\n'
            f'  "plugin": ["{plugin_spec}"]\n'
            "}\n"
        )
        _write_inplace(path, skeleton)
        return f"OK: 已创建 {path}（仅最小骨架）"

    text = path.read_text(encoding="utf-8")
    m = PLUGIN_PAT.search(text)
    if m:
        old = m.group(0)
        if old == plugin_spec:
            return f"OK: opencode.jsonc 已是 {plugin_spec}"
        patched = PLUGIN_PAT.sub(plugin_spec, text, count=1)
        _write_inplace(path, patched)
        return f"OK: opencode.jsonc {old} -> {plugin_spec}"

    inserted = _insert_into_plugin_array(text, plugin_spec)
    if inserted is not None:
        _write_inplace(path, inserted)
        return f"OK: 已 patch 写入 plugin 数组 {plugin_spec}"

    inserted = _insert_plugin_key(text, plugin_spec)
    if inserted is not None:
        _write_inplace(path, inserted)
        return f"OK: 已 patch 追加 plugin 字段 {plugin_spec}"

    return f"WARN: {path} 无法自动 patch，请手动加入：{plugin_spec}"


def remove_opencode_plugin(path: pathlib.Path) -> str:
    """从 plugin 数组移除 agent-tracker 条目（文本级 patch）。"""
    if not path.exists():
        return f"OK: {path} 不存在，无需卸载"

    text = path.read_text(encoding="utf-8")
    if not PLUGIN_PAT.search(text):
        return f"OK: {path} 无 agent-tracker-opencode-plugin 条目"

    # 去掉带可选尾逗号的整行 / 同行条目
    line_pat = re.compile(
        r'^[ \t]*"[^"]*@runmarks/opencode-plugin[^"]*"[ \t]*,?[ \t]*\n?',
        re.MULTILINE,
    )
    patched, n = line_pat.subn("", text, count=1)
    if n == 0:
        # 同行内嵌：去掉 "spec", 或 , "spec"
        inline_pat = re.compile(
            r',?\s*"@runmarks/opencode-plugin(?:@[^"\']+)?"\s*,?'
        )
        patched, n = inline_pat.subn("", text, count=1)
        if n:
            # 清理可能留下的 [, ] 或 ,,
            patched = re.sub(r"\[\s*,", "[", patched)
            patched = re.sub(r",\s*\]", "]", patched)
            patched = re.sub(r",\s*,", ",", patched)

    if n == 0:
        return f"WARN: {path} 找到插件名但无法安全移除，请手动编辑"

    _write_inplace(path, patched)
    return f"OK: 已从 opencode.jsonc patch 移除 agent-tracker-opencode-plugin"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=pathlib.Path, help="opencode.jsonc 路径")
    parser.add_argument(
        "plugin_spec",
        nargs="?",
        help='插件规格，如 @runmarks/opencode-plugin@0.2.10',
    )
    parser.add_argument(
        "--remove",
        action="store_true",
        help="从 plugin 数组移除 agent-tracker 条目",
    )
    args = parser.parse_args(argv)

    if args.remove:
        print(remove_opencode_plugin(args.path))
        return 0
    if not args.plugin_spec:
        parser.error("需要 plugin_spec，或使用 --remove")
    print(patch_opencode_config(args.path, args.plugin_spec))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
