export function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function toolError(text: string) {
  return { ...toolText(text), isError: true };
}

export function notSyncedError() {
  return toolError("Data not synced yet. Please run sync_data first.");
}
