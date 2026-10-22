import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { toolError } from "./result.js";

/**
 * Make every tool registered on `server` from now on sync the state first
 * when it is older than its TTL, so nobody has to remember sync_data and a
 * long-running server does not answer from an old cache. If ZenMoney cannot
 * be reached, a read-only tool still answers from the cache it has and says
 * how old it is. A writing tool fails instead: it would send whole objects
 * built from the old cache, with a newer `changed` that makes them win over
 * edits made elsewhere in the meantime.
 */
export function syncBeforeEachTool(server: McpServer, state: ZenState, except: string[]) {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: ToolConfig,
    handler: Handler
  ) => ReturnType<McpServer["registerTool"]>;
  server.registerTool = ((name: string, config: ToolConfig, handler: Handler) =>
    register(
      name,
      config,
      except.includes(name)
        ? handler
        : withFreshState(state, handler, config.annotations?.readOnlyHint === true)
    )) as typeof server.registerTool;
}

type ToolConfig = { annotations?: { readOnlyHint?: boolean } };
type Result = { content: { type: string; text?: string }[]; isError?: boolean };
// A handler takes (args, extra), or only (extra) when it has no input schema
type Handler = (...args: any[]) => Result | Promise<Result>;

function withFreshState(state: ZenState, handler: Handler, readOnly: boolean): Handler {
  return (async (...args: any[]) => {
    const signal = (args[args.length - 1] as { signal?: AbortSignal } | undefined)?.signal;
    try {
      await state.ensureFresh(signal);
    } catch (error) {
      if (signal?.aborted) return toolError("Cancelled. Nothing was changed.");
      const reason = error instanceof Error ? error.message : String(error);
      if (!state.isSynced) {
        return toolError(`Could not load data from ZenMoney: ${reason}`);
      }
      if (!readOnly) {
        return toolError(
          `Could not refresh data from ZenMoney before the change (${reason}). Nothing was saved; try again later.`
        );
      }
      const result = await handler(...args);
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text" as const,
            text: `Note: refreshing from ZenMoney failed (${reason}), so this is based on data from ${formatAge(state.age)} ago.`,
          },
        ],
      };
    }
    // A sync shared with another call can finish after this one was cancelled
    if (signal?.aborted) return toolError("Cancelled. Nothing was changed.");
    return handler(...args);
  }) as Handler;
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}
