import { type MemoryHost } from "./memory";
import { type OpenCode2Event } from "./opencode2-events";
import { type SkillHost } from "./skill";
type V2Context = Omit<MemoryHost, "session"> & SkillHost & {
    /** opencode.jsonc 对象形式插件条目的 options；字符串条目为 undefined。 */
    options?: unknown;
    session?: Omit<NonNullable<MemoryHost["session"]>, "get"> & {
        get?: (input: {
            sessionID: string;
        }) => Promise<{
            id: string;
            title?: string;
            parentID?: string;
            location: {
                directory: string;
            };
            model?: {
                id: string;
                providerID: string;
            };
        }>;
    };
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