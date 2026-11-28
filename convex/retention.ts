/** Retention policy shared by the control recoveries and the clip-deletion recoveries that back the same undo window. */
export const recoveryRetention = {
  lifetimeMs: 7 * 24 * 60 * 60 * 1000,
  maxPerProject: 1000,
  maxPerActorProject: 128,
};
