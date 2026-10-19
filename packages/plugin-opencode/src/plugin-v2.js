import { execFile } from "node:child_process";
import { FileLogger, TrackerClient, defaultPluginLogPath } from "@agent-tracker/shared";
import { loadPluginConfig } from "./index";
import { createOpenCode2TrackerState, mapOpenCode2Event } from "./opencode2-events";
const gitText = (cwd, args) => new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 1000 }, (error, stdout) => {
        resolve(error ? "" : String(stdout).trim());
    });
});
/** OpenCode 2.0.12 setup：订阅公开事件并转成 Runmark ingest。返回 dispose。 */
export const setupAgentTrackerV2 = async (ctx) => {
    const config = loadPluginConfig();
    const logger = new FileLogger({
        filePath: config.logFile ?? defaultPluginLogPath(),
        enabled: config.debug === true,
        component: "plugin-v2",
    });
    const client = new TrackerClient(config.endpoint, config.apiKey, logger);
    const directory = ctx.location?.directory;
    const state = createOpenCode2TrackerState();
    const [author, repoUrl, branch] = directory
        ? await Promise.all([
            gitText(directory, ["config", "user.email"]),
            gitText(directory, ["remote", "get-url", "origin"]),
            gitText(directory, ["branch", "--show-current"]),
        ]).catch(() => ["", "", ""])
        : ["", "", ""];
    logger.info("plugin v2 initialized", { endpoint: config.endpoint, directory });
    if (!ctx.event?.subscribe) {
        logger.error("opencode v2 context has no event.subscribe");
        return;
    }
    const abort = new AbortController();
    const stream = ctx.event.subscribe({ signal: abort.signal });
    void (async () => {
        try {
            for await (const event of stream) {
                if (abort.signal.aborted)
                    return;
                const mapped = mapOpenCode2Event(state, event, {
                    includeMessageContent: config.includeMessageContent !== false,
                    includeToolOutput: config.includeToolOutput !== false,
                }).map((item) => item.type === "session.created"
                    ? {
                        ...item,
                        repo_url: repoUrl || undefined,
                        branch: branch || undefined,
                        user_email: author || undefined,
                        directory: item.directory ?? directory,
                    }
                    : item);
                for (const item of mapped)
                    client.push(item);
                if (mapped.some((item) => item.type === "session.idle" || item.type === "turn.completed")) {
                    void client.flush();
                }
            }
        }
        catch (error) {
            if (!abort.signal.aborted)
                logger.error("opencode v2 event stream failed", { error: String(error) });
        }
    })();
    return () => {
        abort.abort();
        void client.flush();
    };
};
//# sourceMappingURL=plugin-v2.js.map