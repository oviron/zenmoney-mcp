import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tag } from "../api.js";
import type { ZenState } from "../state.js";
import { toolText } from "../lib/result.js";

const categorySchema = z.object({
  id: z.string(), title: z.string(),
  parentId: z.string().nullable().describe("Parent category id; null for a top-level category"),
  depth: z.number().int().nonnegative().describe("Indentation in the displayed hierarchy; roots have depth 0"),
  expense: z.boolean().optional().describe("Expense flag, shown only for roots"),
  income: z.boolean().optional().describe("Income flag, shown only for roots"),
  missingParentId: z.string().optional(),
});

export function registerCategoryTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "list_categories",
    {
      title: "List Categories",
      description: "List all expense/income categories (tags) with their hierarchy, including categories whose parent is missing.",
      inputSchema: {},
      outputSchema: { categories: z.array(categorySchema) },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {

      const lines: string[] = [];
      const categories: z.infer<typeof categorySchema>[] = [];
      const tagIds = new Set(state.tags.map((tag) => tag.id));
      const children = new Map<string, Tag[]>();
      for (const tag of state.tags) {
        if (tag.parent) {
          const siblings = children.get(tag.parent) ?? [];
          siblings.push(tag);
          children.set(tag.parent, siblings);
        }
      }
      const visited = new Set<string>();

      function appendTag(tag: Tag, depth: number) {
        if (visited.has(tag.id)) return;
        visited.add(tag.id);
        categories.push({
          id: tag.id, title: tag.title, parentId: tag.parent ?? null, depth,
          ...(depth === 0 ? { expense: tag.showOutcome, income: tag.showIncome } : {}),
          ...(depth === 0 && tag.parent && !tagIds.has(tag.parent) ? { missingParentId: tag.parent } : {}),
        });
        if (depth === 0) {
          const flags: string[] = [];
          if (tag.showOutcome) flags.push("expense");
          if (tag.showIncome) flags.push("income");
          const orphan = tag.parent && !tagIds.has(tag.parent)
            ? ` (parent not found: ${tag.parent})`
            : "";
          lines.push(`- **${tag.title}** (${flags.join(", ")}) — id: \`${tag.id}\`${orphan}`);
        } else {
          lines.push(`${"  ".repeat(depth)}- ${tag.title} — id: \`${tag.id}\``);
        }
        for (const child of children.get(tag.id) ?? []) appendTag(child, depth + 1);
      }

      for (const tag of state.tags) {
        if (!tag.parent || !tagIds.has(tag.parent)) appendTag(tag, 0);
      }
      for (const tag of state.tags) appendTag(tag, 0);

      return { ...toolText(
        lines.length > 0
          ? `Categories (${state.tags.length}):\n\n${lines.join("\n")}`
          : "No categories found."
      ), structuredContent: { categories } };
    }
  );

  server.registerTool(
    "list_merchants",
    {
      title: "List Merchants",
      description: "List known merchants/payees.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {

      const lines = state.merchants.map(
        (m) => `- **${m.title}** — id: \`${m.id}\``
      );

      return toolText(
        lines.length > 0
          ? `Merchants (${lines.length}):\n\n${lines.join("\n")}`
          : "No merchants found."
      );
    }
  );
}
