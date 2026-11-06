// packages/gateway/src/connectors/connector-writes/flags.ts
import { type ConnectorWriteRow, row } from "./types.ts";

// Feature-flag writes (connectors 0.6.0, spec 15.3, OR-W34-6). All three are wave 3: a flag change
// can be reverted by flipping it back, so none is wave 4. Untemplated and not offered in C1
// (`not_yet_offered`); C3 templates them with the environment first in the preview.
export const FLAGS_ROWS: readonly ConnectorWriteRow[] = [
  row("launchdarkly_flag_toggle", "launchdarkly.flag.toggle", "mesh", 3),
  row("launchdarkly_flag_rollout_set", "launchdarkly.flag.rollout.set", "mesh", 3),
  row("flagsmith_feature_state_set", "flagsmith.feature.state.set", "mesh", 3),
];
