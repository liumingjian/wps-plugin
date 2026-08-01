(function exposeDocumentIdentityGate(global) {
  "use strict";

  function initialState() {
    return {
      phase: "awaiting-attempt",
      attempt: 0,
      handoffId: null,
      sourceIdentity: null,
      gatewayUrl: null,
      gatewayReceipt: null,
      plugin: null,
      openResult: null,
      gate: { status: "locked", reason: "Verification has not started" },
      controls: { editing: false, save: false, retry: false, return: true },
      error: null,
      events: []
    };
  }

  function withEvent(state, event) {
    return { ...state, events: [...state.events, { type: event.type, at: new Date().toISOString() }] };
  }

  function reduce(state, event) {
    const next = withEvent(state, event);
    if (event.type === "attempt-started") return { ...next, phase: "reading-source", attempt: event.attempt,
      handoffId: event.handoffId, sourceIdentity: null, gatewayUrl: null, gatewayReceipt: null, plugin: null,
      openResult: null, gate: { status: "locked", reason: "Reading authenticated OA source" },
      controls: { editing: false, save: false, retry: false, return: true }, error: null };
    if (event.type === "source-identified") return { ...next, phase: "mounting-plugin", sourceIdentity: event.identity,
      gatewayUrl: event.gatewayUrl, gate: { status: "locked", reason: "Waiting for WPS delivery evidence" } };
    if (event.type === "plugin-ready") return { ...next, phase: "opening-document", plugin: event.plugin };
    if (event.type === "document-opened") return { ...next, phase: "awaiting-receipt", openResult: event.result };
    if (event.type === "gate-passed") return { ...next, phase: "ready", gatewayReceipt: event.receipt,
      gate: { status: "passed", reason: "OA source identity exactly matches the Gateway Delivery Receipt" },
      controls: { editing: true, save: true, retry: false, return: true } };
    if (event.type === "save-started") return { ...next, phase: "saving", controls: { ...state.controls, save: false } };
    if (event.type === "save-finished") return { ...next, phase: "saved", saveResult: event.result,
      controls: { ...state.controls, save: true } };
    if (event.type === "failed") return { ...next, phase: "failed", error: event.error,
      gate: { status: "failed", reason: event.error }, controls: { editing: false, save: false, retry: true, return: true } };
    if (event.type === "return-started") return { ...next, phase: "returning", controls: { ...state.controls, return: false } };
    return next;
  }

  global.DocumentIdentityGate = { initialState, reduce };
})(globalThis);
