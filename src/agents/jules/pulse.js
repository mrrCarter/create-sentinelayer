// Re-export from platform daemon. Pulse is not Jules-specific.
export {
  detectStuckState,
  determineRecoveryAction,
  routeErrorToPersona,
  buildAlertPayload,
  buildHealthSummary,
  sendAlert,
  STUCK_THRESHOLDS,
} from "../../daemon/pulse.js";
