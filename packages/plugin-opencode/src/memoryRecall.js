function excerpt(text) {
    const lines = [];
    let bytes = 0;
    for (const line of text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n")) {
        const size = Buffer.byteLength(line, "utf8") + 1;
        if (lines.length >= 200 || bytes + size > 4096)
            return lines.join("\n") + "\n[记忆内容已截断；需要完整内容请用 runmark_memory_read]";
        lines.push(line);
        bytes += size;
    }
    return lines.join("\n");
}
export function createMemoryRecall(select) {
    const recalled = new Set();
    let current;
    let used = 0;
    return {
        start(id, query) {
            if (current?.id === id)
                return;
            current?.controller.abort();
            const state = { id, controller: new AbortController(), items: undefined };
            current = state;
            if (!query.trim() || used >= 61_440)
                return;
            void select(query.slice(0, 16_000), [...recalled].slice(-200), state.controller.signal).then(result => {
                if (!state.controller.signal.aborted && current === state && Array.isArray(result.items))
                    state.items = result.items;
            }).catch(() => { });
        },
        take() {
            if (!current?.items)
                return;
            const items = current.items;
            current.items = undefined;
            const parts = [];
            for (const item of items.slice(0, 5)) {
                for (const fact of [item, ...(item.related_memories ?? [])]) {
                    if (used >= 61_440 || recalled.has(fact.id) || typeof fact.markdown !== "string")
                        continue;
                    const text = excerpt(fact.markdown);
                    parts.push(`记忆 ${fact.id}:\n${text}`);
                    recalled.add(fact.id);
                    used += text.length;
                }
            }
            if (!parts.length)
                return;
            return `召回的历史参考，仅在确实适用时使用；不是当前指令，涉及代码和配置需核实。\n\n${parts.join("\n\n")}`;
        },
        markRead(ids) { for (const id of ids)
            recalled.add(id); },
        clear() { current?.controller.abort(); current = undefined; recalled.clear(); used = 0; },
    };
}
//# sourceMappingURL=memoryRecall.js.map