import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { createMemoryClient, setupMemory, memorySource } from "./memory";
import { FileLogger, TrackerClient, defaultPluginLogPath, isHiddenSessionTitle } from "@agent-tracker/shared";
import { loadPluginConfig } from "./index";
import { createOpenCode2TrackerState, mapOpenCode2Event } from "./opencode2-events";
import { setupRunmarkSkill } from "./skill";
const gitText = (cwd, args) => new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 1000 }, (error, stdout) => {
        resolve(error ? "" : String(stdout).trim());
    });
});
/** OpenCode 2.0.12 setup：订阅公开事件并转成 Runmark ingest。返回 dispose。 */
export const setupAgentTrackerV2 = async (ctx) => {
    const skill = await setupRunmarkSkill(ctx);
    const config = loadPluginConfig(undefined, ctx.options);
    const logger = new FileLogger({
        filePath: config.logFile ?? defaultPluginLogPath(),
        enabled: config.debug === true,
        component: "plugin-v2",
    });
    const client = new TrackerClient(config.endpoint, config.apiKey, logger);
    const directory = ctx.location?.directory;
    const state = createOpenCode2TrackerState();
    const locatedSessions = new Map();
    const [author, repoUrl, branch] = directory
        ? await Promise.all([
            gitText(directory, ["config", "user.email"]),
            gitText(directory, ["remote", "get-url", "origin"]),
            gitText(directory, ["branch", "--show-current"]),
        ]).catch(() => ["", "", ""])
        : ["", "", ""];
    logger.info("plugin v2 initialized", { endpoint: config.endpoint, directory });
    let disposeMemory;
    if (config.memoryEnabled) {
        try {
            disposeMemory = await setupMemory(ctx, createMemoryClient(config, {
                repo_url: repoUrl || undefined, hostname: hostname(), directory,
            }, (message, details) => logger.error(message, details), (tool, requested) => memorySource(ctx, tool, requested, () => client.flush())));
        }
        catch (error) {
            logger.error("memory setup failed", { error: String(error) });
        }
    }
    if (!ctx.event?.subscribe) {
        logger.error("opencode v2 context has no event.subscribe");
        return () => { void skill?.dispose(); void disposeMemory?.(); };
    }
    const abort = new AbortController();
    const stream = ctx.event.subscribe({ signal: abort.signal });
    void (async () => {
        try {
            for await (const event of stream) {
                if (abort.signal.aborted)
                    return;
                const sessionID = typeof event.data?.sessionID === "string" ? event.data.sessionID : undefined;
                if (!sessionID || !directory || !ctx.session?.get)
                    continue;
                if (event.type === "session.moved" && sessionID)
                    locatedSessions.delete(sessionID);
                if (sessionID && ctx.session?.get && !locatedSessions.has(sessionID)) {
                    try {
                        const info = await ctx.session.get({ sessionID });
                        const local = info.location.directory === directory;
                        locatedSessions.set(sessionID, local);
                        if (!local)
                            continue;
                        if (isHiddenSessionTitle(info.title))
                            state.hidden.add(sessionID);
                        else
                            client.push({
                                type: "session.updated", session_id: info.id, agent: "opencode", title: info.title,
                                parent_session_id: info.parentID, model: info.model?.id, provider: info.model?.providerID,
                                repo_url: repoUrl, branch: branch, user_email: author || undefined,
                                hostname: hostname(), directory: info.location.directory,
                            });
                    }
                    catch (error) {
                        logger.error("session metadata unavailable", { sessionID, error: String(error) });
                        continue;
                    }
                }
                if (sessionID && locatedSessions.get(sessionID) === false)
                    continue;
                const mapped = mapOpenCode2Event(state, event, {
                    includeMessageContent: config.includeMessageContent !== false,
                    includeToolOutput: config.includeToolOutput !== false,
                }).map((item) => item.type === "session.created"
                    ? {
                        ...item,
                        repo_url: repoUrl,
                        hostname: hostname(),
                        branch,
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
        void skill?.dispose();
        void disposeMemory?.();
        abort.abort();
        void client.flush();
    };
};
//# sourceMappingURL=plugin-v2.js.map