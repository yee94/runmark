#!/usr/bin/env python3
"""原地 patch opencode.jsonc：迁移 Runmark 插件条目，禁止整文件覆写。

约束：
- 已有配置必须文本级 patch（保留注释、尾逗号、其它 plugin、其它顶层字段）
- 跟随 symlink 写入目标文件，不得用临时文件 mv 替换路径（否则会拆掉 Mackup 等 symlink）
- 仅当配置文件不存在时，才创建最小骨架
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

PLUGIN_BASE = "@runmarks/opencode-plugin"
PLUGIN_PAT = re.compile(
    r"@runmarks/(?:opencode-plugin|agent-tracker-opencode-plugin)(?:@[^\"'\s,\]]+)?"
)
TOKEN_PAT = re.compile(
    r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|[{}\[\]:,]|[^\s{}\[\]:,]+'
)


def _tokens(text: str) -> list[re.Match[str]]:
    return [m for m in TOKEN_PAT.finditer(text) if not m.group().startswith(("//", "/*"))]


def _plugin_arrays(text: str):
    """定位顶层 plugin / plugins 数组及条目，保留原始文本位置。"""
    tokens = _tokens(text)
    depth = 0
    for i, token in enumerate(tokens):
        value = token.group()
        if depth == 1 and value in ('"plugin"', '"plugins"') and [t.group() for t in tokens[i + 1:i + 3]] == [":", "["]:
            entries = []
            current = []
            nested = 0
            for item in tokens[i + 3:]:
                part = item.group()
                if part == "]" and nested == 0:
                    if current:
                        entries.append((current, None))
                    yield tokens[i + 2], entries
                    break
                if part == "," and nested == 0:
                    entries.append((current, item))
                    current = []
                    continue
                current.append(item)
                if part in ("{", "["):
                    nested += 1
                elif part in ("}", "]"):
                    nested -= 1
        if value in ("{", "["):
            depth += 1
        elif value in ("}", "]"):
            depth -= 1


def _package_token(tokens):
    if not tokens:
        return None
    candidate = tokens[0]
    if candidate.group() == "[" and len(tokens) > 1:
        candidate = tokens[1]
    elif candidate.group() == "{":
        depth = 0
        candidate = None
        for i, token in enumerate(tokens):
            value = token.group()
            if depth == 1 and value == '"package"' and tokens[i + 1].group() == ":":
                candidate = tokens[i + 2]
                break
            if value in ("{", "["):
                depth += 1
            elif value in ("}", "]"):
                depth -= 1
    if candidate and candidate.group().startswith('"') and PLUGIN_PAT.fullmatch(json.loads(candidate.group())):
        return candidate
    return None


def _edit_plugins(text: str, plugin_spec: str | None) -> tuple[str, int]:
    """替换首个 Runmark 条目并移除重复项；卸载时移除新旧包名。"""
    edits = {}
    matched = 0
    for _, entries in _plugin_arrays(text):
        last_kept_comma = None
        for i, (tokens, comma) in enumerate(entries):
            package = _package_token(tokens)
            if package is None:
                last_kept_comma = comma
                continue
            matched += 1
            if plugin_spec is not None and matched == 1:
                edits[package.span()] = json.dumps(plugin_spec)
                last_kept_comma = comma
                continue
            for token in tokens:
                edits[token.span()] = ""
            separator = comma if comma is not None else last_kept_comma
            if separator is not None:
                edits[separator.span()] = ""
    for (start, end), replacement in sorted(edits.items(), reverse=True):
        text = text[:start] + replacement + text[end:]
    return text, matched


def _write_inplace(path: pathlib.Path, text: str) -> None:
    """跟随 symlink 原地写入，避免替换路径本身。"""
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


def _insert_into_plugin_array(text: str, plugin_spec: str) -> str | None:
    """在已有 plugin / plugins 数组开头插入条目。"""
    array = next(_plugin_arrays(text), None)
    if array is None:
        return None
    # 非空数组：紧跟 [ 后插入一行
    opening, entries = array
    insert_at = opening.end()
    suffix = "," if entries else ""
    return text[:insert_at] + f'\n    "{plugin_spec}"{suffix}\n' + text[insert_at:]


def _insert_plugin_key(text: str, plugin_spec: str) -> str | None:
    """配置里没有插件字段时，在顶层对象末尾追加 plugins，不碰其它键。"""
    # 从末尾找与首个 { 匹配的 }，在其前插入
    tokens = _tokens(text)
    if not tokens or tokens[0].group() != "{":
        return None
    depth = 0
    end = -1
    for token in tokens:
        ch = token.group()
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = token.start()
                break
    if end < 0:
        return None

    before = text[:end]
    # 若最后一个非空白不是 { 或 ,，补一个逗号
    previous = next(token for token in reversed(tokens) if token.end() <= end)
    if previous.group() not in "{,":
        before = before[:previous.end()] + "," + before[previous.end():]
    block = f'\n  "plugins": [\n    "{plugin_spec}"\n  ]\n'
    return before + block + text[end:]


def patch_opencode_config(path: pathlib.Path, plugin_spec: str) -> str:
    """
    patch 或创建 opencode.jsonc。
    返回人类可读状态行（OK: / WARN:）。
    """
    if plugin_spec != PLUGIN_BASE and not (plugin_spec.startswith(PLUGIN_BASE + "@") and PLUGIN_PAT.fullmatch(plugin_spec)):
        raise SystemExit(f"invalid plugin spec: {plugin_spec}")

    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        skeleton = (
            "{\n"
            '  "$schema": "https://opencode.ai/config.json",\n'
            f'  "plugins": ["{plugin_spec}"]\n'
            "}\n"
        )
        _write_inplace(path, skeleton)
        return f"OK: 已创建 {path}（仅最小骨架）"

    text = path.read_text(encoding="utf-8")
    patched, matched = _edit_plugins(text, plugin_spec)
    if matched:
        if patched == text:
            return f"OK: opencode.jsonc 已是 {plugin_spec}"
        _write_inplace(path, patched)
        return f"OK: opencode.jsonc Runmark -> {plugin_spec}（合并 {matched} 个条目）"

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
    """从 plugin / plugins 数组移除 Runmark 新旧包名（文本级 patch）。"""
    if not path.exists():
        return f"OK: {path} 不存在，无需卸载"

    text = path.read_text(encoding="utf-8")
    patched, matched = _edit_plugins(text, None)
    if not matched:
        return f"OK: {path} 无 Runmark 插件条目"

    _write_inplace(path, patched)
    return f"OK: 已从 opencode.jsonc patch 移除 Runmark 插件"


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
        help="从 plugin / plugins 数组移除 Runmark 新旧条目",
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
