export const MANAGER_SNAPSHOT_MARKER = "PASEO_PI_SUBAGENT_MANAGER_V1";

/** Only the manager's public observation bus is used; no service/control objects are exposed. */
export const managerRuntimeBridge = `
  let managerContext;
  const requestManagerSnapshot = (ctx) => {
    managerContext = ctx;
    pi.events.emit("pi-subagent-manager:observe:v1:request", {});
  };
  const stopManagerObservation = pi.events.on("pi-subagent-manager:observe:v1:snapshot", (snapshot) => {
    if (managerContext && snapshot?.rootSessionId === managerContext.sessionManager.getSessionId()) {
      managerContext.ui.notify("${MANAGER_SNAPSHOT_MARKER} " + JSON.stringify(snapshot), "info");
    }
  });
  const stopManagerCapture = pi.events.on("paseo:extensions:snapshot", requestManagerSnapshot);
  pi.on("session_start", (_event, ctx) => requestManagerSnapshot(ctx));
  pi.on("session_tree", (_event, ctx) => requestManagerSnapshot(ctx));
  pi.on("session_shutdown", () => {
    managerContext = undefined;
    stopManagerObservation();
    stopManagerCapture();
  });
`;
