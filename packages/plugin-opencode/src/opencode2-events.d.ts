import type { IngestEvent } from "@agent-tracker/shared";
export type OpenCode2Event = {
    type: string;
    id?: string;
    created?: number;
    data?: Record<string, unknown>;
};
export type OpenCode2TrackerState = {
    hidden: Set<string>;
    forkCutoffMs: Map<string, number>;
    pending: Map<string, {
        model: string;
        provider: string;
        startTime: number;
        messageID?: string;
    }>;
    texts: Map<string, Map<number, string>>;
    tools: Map<string, {
        name: string;
        input?: Record<string, unknown>;
    }>;
    completed: Set<string>;
};
export declare const createOpenCode2TrackerState: () => OpenCode2TrackerState;
export declare const mapOpenCode2Event: (state: OpenCode2TrackerState, event: OpenCode2Event, options: {
    includeMessageContent: boolean;
    includeToolOutput: boolean;
    now?: number;
}) => IngestEvent[];
//# sourceMappingURL=opencode2-events.d.ts.map