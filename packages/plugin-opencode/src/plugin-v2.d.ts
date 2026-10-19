import { type OpenCode2Event } from "./opencode2-events";
type V2Context = {
    location?: {
        directory?: string;
    };
    event?: {
        subscribe: (options?: {
            signal?: AbortSignal;
        }) => AsyncIterable<OpenCode2Event>;
    };
};
/** OpenCode 2.0.12 setup：订阅公开事件并转成 Runmark ingest。返回 dispose。 */
export declare const setupAgentTrackerV2: (ctx: V2Context) => Promise<(() => void) | void>;
export {};
//# sourceMappingURL=plugin-v2.d.ts.map