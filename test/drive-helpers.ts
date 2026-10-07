import assert from "node:assert/strict";

import type { RunId } from "../src/contracts.js";
import type { RunCoordinator } from "../src/run-coordinator.js";

export interface OwnedDrive {
  drivePromise: Promise<void>;
  driveError?: unknown;
}

// Deadlock protection after fixture controls/execution are released, not a check budget:
// two verifications × (5s probe + 5s command + two 3s termination/group cleanups), plus 3s settlement.
export const DRIVE_SETTLEMENT_WATCHDOG_MS = 35_000;

export function ownedDrive(coordinator: RunCoordinator, runId: RunId): OwnedDrive {
  const drive = (coordinator as unknown as { reservation?: OwnedDrive & { runId: RunId } }).reservation;
  assert.ok(drive?.drivePromise, "the accepted Start must own a drive");
  assert.equal(drive.runId, runId, "await the exact run's reservation");
  return drive;
}

export async function awaitDrive(drive: OwnedDrive, signal = AbortSignal.timeout(DRIVE_SETTLEMENT_WATCHDOG_MS)): Promise<void> {
  let onAbort!: () => void;
  try {
    const watchdog = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    await Promise.race([drive.drivePromise, watchdog]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (drive.driveError !== undefined) throw drive.driveError;
}
