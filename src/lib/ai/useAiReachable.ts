/**
 * Whether an assisted action may be offered on a connection: the AI module is
 * on (Settings → AI) and the connection's profile has `ai_enabled`. A
 * `::db::` view is read through its parent, like the backend's own gate.
 *
 * ADR #136's rule applied to the AI: an action the connection can never take
 * is not offered at all, rather than shown disabled. The query editor's
 * toolbar is the consumer that needed it (ADR #137); `AiPanel` reads the
 * profile half itself because it shows the panel either way and explains
 * what is off.
 *
 * This only decides what to *offer*. The backend refuses an AI request on a
 * connection that is not enabled regardless (ADR #96).
 */

import { parentConnectionId } from "@/lib/connectionLabel";
import { moduleEnabled } from "@/lib/panelModules";
import { useConnections } from "@/stores/session/connections";
import { usePreferences } from "@/stores/preferences/preferences";

export function useAiReachable(connectionId: string): boolean {
  const moduleOn = usePreferences((s) => moduleEnabled(s.prefs, "ai"));
  const parent = parentConnectionId(connectionId);
  // A boolean selector: compared by value, so it re-renders only on a flip.
  const profileOn = useConnections(
    (s) => !!s.profiles.find((p) => p.id === parent)?.ai_enabled,
  );
  return moduleOn && profileOn;
}
