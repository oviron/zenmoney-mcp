import { describe, expect, it, vi } from "vitest";
import { validateDiffResponse, ZenMoneyError } from "../src/api.js";
import { ZenState } from "../src/state.js";
import { createMockApi } from "./helpers.js";
import { makeDiffResponse } from "./fixtures.js";
import { reminder, marker } from "./reminder-fixtures.js";

describe("reminder state", () => {
  it("parses, fetches and merges reminders and markers by id", async () => {
    const response = validateDiffResponse({ serverTimestamp: 1, reminder: [reminder()], reminderMarker: [marker()] });
    const api = createMockApi(response);
    const state = new ZenState(api);
    await state.sync();
    expect(vi.mocked(api.diff).mock.calls[0][0].forceFetch).toEqual(expect.arrayContaining(["reminder", "reminderMarker"]));
    expect(state.reminders).toEqual([reminder()]);
    expect(state.reminderMarkers).toEqual([marker()]);
    vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse({
      reminder: [reminder({ comment: "new" })],
      reminderMarker: [marker({ state: "processed" }), marker({ id: "marker-2" })],
    }));
    await state.sync();
    expect(state.reminders).toEqual([reminder({ comment: "new" })]);
    expect(state.reminderMarkers.map((m) => m.state)).toEqual(["processed", "planned"]);
  });

  it("applies deletion for each entity without cascading over processed markers", async () => {
    const api = createMockApi({ reminder: [reminder()], reminderMarker: [marker(), marker({ id: "processed", state: "processed" })] });
    const state = new ZenState(api);
    await state.sync();
    vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse({ deletion: [
      { object: "reminder", id: "reminder-1", user: 1, stamp: 1 },
      { object: "reminderMarker", id: "marker-1", user: 1, stamp: 1 },
    ] }));
    await state.sync();
    expect(state.reminders).toEqual([]);
    expect(state.reminderMarkers.map((m) => m.id)).toEqual(["processed"]);
  });

  it("clears reminders and markers on full sync, retaining them on failure", async () => {
    const api = createMockApi({ reminder: [reminder()], reminderMarker: [marker()] });
    const state = new ZenState(api);
    await state.sync();
    vi.mocked(api.diff).mockRejectedValueOnce(new Error("offline"));
    await expect(state.sync(true)).rejects.toThrow("offline");
    expect(state.reminders).toHaveLength(1);
    expect(state.reminderMarkers).toHaveLength(1);
    vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse());
    await state.sync(true);
    expect(state.reminders).toEqual([]);
    expect(state.reminderMarkers).toEqual([]);
  });

  it("names reminder and marker ids and their listing tools for an uncertain write", async () => {
    const api = createMockApi();
    const state = new ZenState(api);
    await state.sync();
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("timeout", true));
    await expect(state.write({ reminder: [reminder()], reminderMarker: [marker()] }))
      .rejects.toThrow(/reminder-1, 1 reminder marker.*list_reminders.*list_upcoming/);
    expect(state.reminders).toEqual([]);
    expect(state.reminderMarkers).toEqual([]);
  });

  it.each(["reminder", "reminderMarker"])("rejects malformed %s arrays before merging", (key) => {
    expect(() => validateDiffResponse({ serverTimestamp: 1, [key]: [{}] })).toThrow("without id");
    expect(() => validateDiffResponse({ serverTimestamp: 1, [key]: {} })).toThrow("not a list");
  });
});
