import type { IngestEvent, IngestMessageEvent } from "@agent-tracker/shared";
export type OpenCode2Event = {
    type: string;
    id?: string;
    created?: number;
    data?: Record<string, unknown>;
};
export type OpenCode2TrackerState = {
    userMessages: Map<string, IngestMessageEvent>;
    deliveredUsers: Set<string>;
    seenInputs: Set<string>;
    inputClients: Map<string, {
        sessionID: string;
        clientID?: string;
    }>;
    executionClients: Map<string, string | undefined>;
    sessionAgents: Map<string, string>;
    hidden: Set<string>;
    forkCutoffMs: Map<string, number>;
    pending: Map<string, {
        model: string;
        provider: string;
        startTime: number;
        messageID?: string;
        agentKey?: string;
        clientID?: string;
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