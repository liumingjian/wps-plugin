(function editorUiPrototype() {
  "use strict";

  const variants = [
    { key: "A", name: "紧凑工具栏" },
    { key: "B", name: "状态优先" },
    { key: "C", name: "侧边操作栏" }
  ];
  const validStates = new Set(["loading", "ready", "saving", "saved", "failed"]);
  const stateCopy = {
    loading: ["正在打开正文", "正在连接本机 WPS，请稍候"],
    ready: ["正文可编辑", "修改完成后点击保存"],
    saving: ["正在保存", "正在将正文覆盖写回 OA"],
    saved: ["已保存", "正文已成功写回 OA"],
    failed: ["保存失败", "正文未写回 OA，可重试或放弃修改后返回"]
  };

  const app = document.getElementById("app");
  const stateSelect = document.getElementById("state-select");
  const variantLabel = document.getElementById("variant-label");
  const dialog = document.getElementById("discard-dialog");
  let currentVariant = readVariant();
  let currentState = readState();

  function readVariant() {
    const value = new URLSearchParams(location.search).get("variant");
    return variants.some((variant) => variant.key === value) ? value : "A";
  }

  function readState() {
    const value = new URLSearchParams(location.search).get("state");
    return validStates.has(value) ? value : "ready";
  }

  function setQuery(next) {
    const params = new URLSearchParams(location.search);
    Object.entries(next).forEach(([key, value]) => params.set(key, value));
    history.replaceState(null, "", "?" + params.toString());
  }

  function button(kind, label, options) {
    const config = options || {};
    const disabled = config.disabled ? " disabled" : "";
    const className = "action" + (config.primary ? " primary" : "") + (config.extraClass ? " " + config.extraClass : "");
    const symbol = config.symbol ? `<span class="symbol" aria-hidden="true">${config.symbol}</span>` : "";
    return `<button class="${className}" data-action="${kind}" type="button"${disabled} title="${label}">${symbol}<span class="label">${label}</span></button>`;
  }

  function statusMarkup(detailed) {
    const copy = stateCopy[currentState];
    if (!detailed) return `<span class="status">${copy[0]}</span>`;
    return `<div class="status-copy"><span class="status">${copy[0]}</span><span class="status-detail">${copy[1]}</span></div>`;
  }

  function messageMarkup() {
    if (currentState === "failed") {
      return `<aside class="message failure-message" role="alert"><strong>正文未保存。</strong> OA 原文未发生修改，请重试保存；返回将放弃本次编辑。</aside>`;
    }
    if (currentState === "saved") {
      return `<aside class="message success-message" role="status"><strong>保存成功。</strong> 现在可以返回 OA 继续办理。</aside>`;
    }
    return "";
  }

  function commandButtons(sideRail) {
    const unavailable = currentState === "loading" || currentState === "saving";
    const saveLabel = currentState === "failed" ? "重试保存" : "保存";
    return [
      button("save", saveLabel, { primary: true, disabled: unavailable, symbol: currentState === "failed" ? "&#8635;" : "" }),
      button("return", "返回 OA", { disabled: unavailable, symbol: "&#8592;", extraClass: sideRail ? "return-action" : "" })
    ].join("");
  }

  function wpsSurface() {
    return document.getElementById("wps-surface-template").innerHTML;
  }

  function variantA() {
    return `<section class="editor variant-a" data-state="${currentState}">
      <header class="toolbar">
        <div class="identity"><strong class="document-title">云堡垒机使用手册.docx</strong><span class="document-path">流程正文 / 2026-08</span></div>
        ${statusMarkup(false)}
        ${commandButtons(false)}
      </header>
      <div class="workspace">${messageMarkup()}${wpsSurface()}</div>
    </section>`;
  }

  function variantB() {
    return `<section class="editor variant-b" data-state="${currentState}">
      <header class="titlebar"><strong class="document-title">云堡垒机使用手册.docx</strong><span class="document-path">OA 流程正文</span></header>
      <div class="command-band">${statusMarkup(true)}<div class="actions">${commandButtons(false)}</div></div>
      <div class="workspace">${messageMarkup()}${wpsSurface()}</div>
    </section>`;
  }

  function variantC() {
    return `<section class="editor variant-c" data-state="${currentState}">
      <header class="topbar"><strong class="document-title">云堡垒机使用手册.docx</strong>${statusMarkup(false)}</header>
      <nav class="rail" aria-label="正文操作">${commandButtons(true)}</nav>
      <div class="workspace">${messageMarkup()}${wpsSurface()}</div>
    </section>`;
  }

  function render() {
    const renderVariant = { A: variantA, B: variantB, C: variantC }[currentVariant];
    app.innerHTML = renderVariant();
    stateSelect.value = currentState;
    const variant = variants.find((item) => item.key === currentVariant);
    variantLabel.textContent = variant.key + " - " + variant.name;
    bindPageActions();
  }

  function bindPageActions() {
    app.querySelectorAll('[data-action="save"]').forEach((element) => {
      element.addEventListener("click", () => {
        currentState = "saving";
        setQuery({ state: currentState });
        render();
        window.setTimeout(() => {
          currentState = "saved";
          setQuery({ state: currentState });
          render();
        }, 900);
      });
    });
    app.querySelectorAll('[data-action="return"]').forEach((element) => {
      element.addEventListener("click", () => {
        if (currentState === "failed") dialog.showModal();
        else restoreOa();
      });
    });
  }

  function restoreOa() {
    dialog.close();
    app.innerHTML = `<section class="oa-restored"><div class="oa-page"><header class="oa-header">公文办理</header><div class="oa-content"><h1>OA 页面已恢复</h1><p>编辑器页面与嵌入的 WPS 对象已随同标签页导航销毁。</p><button id="reopen-editor" type="button">再次打开正文</button></div></div></section>`;
    document.getElementById("reopen-editor").addEventListener("click", render);
  }

  function cycleVariant(direction) {
    const index = variants.findIndex((variant) => variant.key === currentVariant);
    currentVariant = variants[(index + direction + variants.length) % variants.length].key;
    setQuery({ variant: currentVariant });
    render();
  }

  document.getElementById("previous-variant").addEventListener("click", () => cycleVariant(-1));
  document.getElementById("next-variant").addEventListener("click", () => cycleVariant(1));
  stateSelect.addEventListener("change", () => {
    currentState = stateSelect.value;
    setQuery({ state: currentState });
    render();
  });
  document.getElementById("confirm-discard").addEventListener("click", restoreOa);
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target.matches("input, textarea, select, [contenteditable]")) return;
    if (event.key === "ArrowLeft") cycleVariant(-1);
    if (event.key === "ArrowRight") cycleVariant(1);
  });
  window.addEventListener("popstate", () => {
    currentVariant = readVariant();
    currentState = readState();
    render();
  });

  render();
})();
