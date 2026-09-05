import { CdpError } from "./client.js";
import { bumpGeneration, getCurrentGeneration } from "./generation.js";
import {
  checkUidGeneration,
  parseStampedUid,
  stampSnapshotGeneration,
} from "./snapshot.js";

export type ToolCaller = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<string>;

export const PAGE_GENERATION_KEY = "__chromeDevtoolsAxiSnapshotGeneration";

export async function captureFreshSnapshot(
  caller: ToolCaller,
  capture: () => Promise<string>,
): Promise<string> {
  const generation = bumpGeneration();
  await markPageSnapshotGeneration(generation, caller);
  const snapshot = await capture();
  return stampSnapshotGeneration(snapshot, generation);
}

function throwStaleRef(
  arg: string,
  refGeneration: number | null,
  currentGeneration: number | null,
): never {
  const refRaw = arg.startsWith("@") ? arg.slice(1) : arg;
  const current = currentGeneration ?? "unavailable";
  throw new CdpError(
    `Stale ref @${refRaw}: from snapshot generation ${refGeneration}, current is ${current}. Re-snapshot to get fresh refs.`,
    "STALE_REF",
    [
      "Run `chrome-devtools-axi snapshot` to capture current refs, then retry the action",
    ],
  );
}

async function markPageSnapshotGeneration(
  generation: number,
  caller: ToolCaller,
): Promise<void> {
  const key = JSON.stringify(PAGE_GENERATION_KEY);
  try {
    await caller("evaluate_script", {
      function: `() => {
  const key = ${key};
  const previous = globalThis[key];
  if (previous && previous.observer) previous.observer.disconnect();
  const state = { generation: ${generation}, mutations: 0, observer: null };
  const observer = new MutationObserver(() => { state.mutations += 1; });
  observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
  state.observer = observer;
  globalThis[key] = state;
  return state.generation;
}`,
    });
  } catch {}
}

interface PageRefState {
  generation: number;
  mutations: number;
}

async function getPageRefState(
  caller: ToolCaller,
): Promise<PageRefState | null> {
  const key = JSON.stringify(PAGE_GENERATION_KEY);
  try {
    const output = await caller("evaluate_script", {
      function: `() => {
  const state = globalThis[${key}];
  if (!state || typeof state.generation !== 'number' || typeof state.mutations !== 'number' || !state.observer) return null;
  return { generation: state.generation, mutations: state.mutations };
}`,
    });
    const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
    const raw = jsonBlock?.[1] ?? output.replace(
      /^Script ran on page and returned:\s*/,
      "",
    );
    const parsed: unknown = JSON.parse(raw.trim());
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as PageRefState).generation !== "number" ||
      typeof (parsed as PageRefState).mutations !== "number"
    ) {
      return null;
    }
    return parsed as PageRefState;
  } catch {
    return null;
  }
}

export async function parseUidFresh(
  arg: string,
  caller: ToolCaller,
): Promise<string> {
  const snapshotGeneration = getCurrentGeneration();
  const check = checkUidGeneration(arg, snapshotGeneration);
  if (check.stale) {
    throwStaleRef(arg, check.refGeneration, snapshotGeneration);
  }

  const state = await getPageRefState(caller);
  if (
    !state ||
    state.generation !== snapshotGeneration ||
    state.mutations !== 0
  ) {
    throwStaleRef(
      arg,
      parseStampedUid(arg).generation ?? snapshotGeneration,
      state ? state.generation + state.mutations : null,
    );
  }
  return check.uid;
}
