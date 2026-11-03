type RecalledMemory = {
    id: string;
    markdown: string;
    related_memories?: Array<{
        id: string;
        markdown: string;
    }>;
};
type Select = (query: string, exclude: string[], signal: AbortSignal) => Promise<{
    items: RecalledMemory[];
}>;
export declare function createMemoryRecall(select: Select): {
    start(id: string, query: string): void;
    take(): string | undefined;
    markRead(ids: string[]): void;
    clear(): void;
};
export {};
//# sourceMappingURL=memoryRecall.d.ts.map