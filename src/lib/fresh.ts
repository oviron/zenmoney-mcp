import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { toolError } from "./result.js";

/**
 * Make every tool registered on `server` from now on sync the state first
 * when it is older than its TTL, so nobody has to remember sync_data and a
 * long-running server does not answer from an old cache. If ZenMoney cannot
 * be reached, a tool still answers from the cache it has and says how old
 * it is; with no cache at all it fails.
 */
export function syncBeforeEachTool(server: McpServer, state: ZenState, except: string[]) {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: Handler
  ) => ReturnType<McpServer["registerTool"]>;
  server.registerTool = ((name: string, config: unknown, handler: Handler) =>
    register(
      name,
      config,
      except.includes(name) ? handler : withFreshState(state, handler)
    )) as typeof server.registerTool;
}

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
// A handler takes (args, extra), or only (extra) when it has no input schema
type Handler = (...args: any[]) => Result | Promise<Result>;

function withFreshState(state: ZenState, handler: Handler): Handler {
  return (async (...args: any[]) => {
    const extra = args[args.length - 1] as { signal?: AbortSignal } | undefined;
    try {
      await state.ensureFresh(extra?.signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!state.isSynced) {
        return toolError(`Could not load data from ZenMoney: ${reason}`);
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
