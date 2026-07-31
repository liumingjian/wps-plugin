(function exposePrototypeFlow(global) {
  "use strict";

  function initialFlow() {
    return {
      phase: "awaiting-handoff",
      sourcePath: null,
      gatewayUrl: null,
      saveUrl: null,
      plugin: null,
      openResult: null,
      saveResult: null,
      error: null,
      integrityGate: "DEFERRED: openDocument and ActiveDocument do not verify Document identity",
      events: []
    };
  }

  function reduceFlow(state, event) {
    const next = { ...state, events: [...state.events, { type: event.type, at: new Date().toISOString() }] };
    if (event.type === "handoff-consumed") return { ...next, phase: "mounting-plugin", sourcePath: event.sourcePath, gatewayUrl: event.gatewayUrl, saveUrl: event.saveUrl };
    if (event.type === "plugin-ready") return { ...next, phase: "opening-document", plugin: event.plugin };
    if (event.type === "document-opened") return { ...next, phase: "ready", openResult: event.result };
    if (event.type === "save-started") return { ...next, phase: "saving", saveResult: null };
    if (event.type === "save-finished") return { ...next, phase: "saved", saveResult: event.result };
    if (event.type === "return-started") return { ...next, phase: "returning" };
    if (event.type === "failed") return { ...next, phase: "failed", error: event.error };
    return next;
  }

  global.PrototypeFlow = { initialFlow, reduceFlow };
})(globalThis);

