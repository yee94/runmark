import type { PluginConfig } from "@agent-tracker/shared";
export declare const MEMORY_MARKER = "<runmark-project-memory>";
export declare const memoryAgentKey: (agent?: string) => string | undefined;
export type MemoryToolContext = {
    sessionID: string;
    agent?: string;
    messageID?: string;
    id?: string;
    signal?: AbortSignal;
};
type MemorySourceMessage = {
    id: string;
    type: string;
    text?: string;
    synthetic?: boolean;
    visibility?: string;
    metadata?: Record<string, unknown>;
};
export type MemoryTool = {
    name: string;
    description: string;
    options: {
        codemode: false;
    };
    input: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: false;
    };
    execute: (input: Record<string, unknown>, context: MemoryToolContext) => Promise<{
        content: string;
    }>;
};
export type MemoryHost = {
    location?: {
        directory?: string;
    };
    session?: {
        get?: (input: {
            sessionID: string;
        }) => Promise<{
            location: {
                directory: string;
            };
        }>;
        context?: (input: {
            sessionID: string;
        }) => Promise<readonly MemorySourceMessage[]>;
        synthetic?: (input: {
            sessionID: string;
            text: string;
            resume: false;
            metadata: Record<string, unknown>;
        }) => Promise<unknown>;
        hook: (name: "context", handler: (event: {
            sessionID: string;
            agent?: string;
            system: Array<{
                type: string;
                text?: string;
            }>;
        }) => Promise<void>) => Promise<{
            dispose(): Promise<void>;
        }>;
    };
    tool?: {
        transform: (callback: (editor: {
            add(tool: MemoryTool): void;
        }) => void) => Promise<{
            dispose(): Promise<void>;
        }>;
    };
};
export declare function memorySource(host: MemoryHost, tool: MemoryToolContext, requested: string | undefined, flush: () => Promise<void>): Promise<string>;
export declare function createMemoryClient(config: Pick<PluginConfig, "endpoint" | "apiKey">, project: {
    repo_url?: string;
    hostname?: string;
    directory?: string;
}, log: (message: string, details?: Record<string, unknown>) => void, sourceMessage?: (context: MemoryToolContext, requested?: string) => Promise<string | undefined>): {
    snapshot: (sessionID: string, agent?: string) => Promise<string | undefined>;
    tools: MemoryTool[];
    updates: (sessionID: string, agent: string | undefined, notify: (text: string) => Promise<unknown>) => Promise<void>;
    recall: (sessionID: string, agent?: string) => {
        start(id: string, query: string): void;
        take(): string | undefined;
        markRead(ids: string[]): void;
        clear(): void;
    };
    retrievalMode: "index" | "semantic";
    clear: () => void;
};
export declare function setupMemory(host: MemoryHost, memory: ReturnType<typeof createMemoryClient>): Promise<() => Promise<void>>;
export {};
//# sourceMappingURL=memory.d.ts.map