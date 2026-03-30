import fs from "node:fs";
import path from "node:path";
import type { AppState } from "./types";

const STATE_PATH = path.join(process.cwd(), "state.json");

export function readState(): AppState {
  if (!fs.existsSync(STATE_PATH)) {
    return { accounts: {} };
  }

  const raw = fs.readFileSync(STATE_PATH, "utf8");
  const parsed = JSON.parse(raw) as AppState;
  if (!parsed?.accounts) return { accounts: {} };
  return parsed;
}

export function writeState(state: AppState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function ensureAccountState(
  state: AppState,
  accountKey: string
): AppState {
  if (!state.accounts[accountKey]) {
    state.accounts[accountKey] = {
      lastShortcode: null,
      lastNotifiedAt: null,
    };
  }
  return state;
}

