/**
 * Open state for "publish this correction back to the origin" (the prompt that
 * follows a publisher saving an origin-owned connection locally).
 *
 * A store rather than local state in `ConnectionDialog`, for one reason that
 * decides it: the prompt has to outlive the dialog that raises it. Saving keeps
 * the connection dialog open, but *connecting* saves and then closes it, and
 * "fix the password, connect, done" is the flow a rotated credential actually
 * produces. A `useState` in there would take the prompt down with the dialog in
 * exactly the case it matters most.
 *
 * Everything the prompt renders is captured at open time. It names a connection
 * and an origin that the user has, by then, already stopped looking at.
 */

import { create } from "zustand";

export interface OriginRepublishRequest {
  originId: string;
  originName: string;
  profileId: string;
  profileName: string;
  /**
   * Whether the local save changed the *secret*, which is the only thing that
   * makes a republish re-encrypt. An unchanged envelope travels verbatim
   * (ADR #56): re-encrypting draws a fresh salt and nonce, invalidating
   * every consumer's `landedSecrets` fingerprint and costing each of them
   * ~600 000 PBKDF2 rounds for a password that did not change.
   */
  withSecret: boolean;
}

interface OriginRepublishState {
  pending: OriginRepublishRequest | null;
  open: (request: OriginRepublishRequest) => void;
  close: () => void;
}

export const useOriginRepublish = create<OriginRepublishState>((set) => ({
  pending: null,
  open: (request) => set({ pending: request }),
  close: () => set({ pending: null }),
}));
