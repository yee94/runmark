/**
 * Cursor 同步定时调度器。
 * 每 5 分钟检查一次；启动后延迟 30s 首次运行。
 */

import type { CursorService } from "./cursor";
import type { FileLogger } from "@agent-tracker/shared";

const INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

export function startCursorScheduler(service: CursorService, logger: FileLogger): () => void {
  let timer: Timer | null = null;
  let running = false;

  const run = async () => {
    if (running) return;
    if (!service.getStatus().available) return;
    running = true;
    try {
      await service.sync();
      logger.info("Cursor scheduled sync completed");
    } catch (err) {
      logger.error(`Cursor scheduled sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => {
    run();
  }, STARTUP_DELAY_MS);

  timer = setInterval(run, INTERVAL_MS);

  return () => {
    clearTimeout(initial);
    if (timer) clearInterval(timer);
  };
}
