export function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function toolError(text: string) {
  return { ...toolText(text), isError: true };
}
