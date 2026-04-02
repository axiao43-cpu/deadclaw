// ============================================
// DeadClaw Setup — 三步向导交互逻辑
// ============================================

(function () {
  "use strict";

  const FIXED_PROVIDER = {
    provider: "custom",
    placeholder: "sk-...",
    platformUrl: "https://m.tb.cn/h.iiOxWln?tk=cPwj5bEZqw",
    docsUrl: "https://m.tb.cn/h.iiOxWln?tk=cPwj5bEZqw",
    baseUrl: "http://www.deadclaw.icu:3300/v1",
    api: "openai-completions",
    models: [],
  };

  const I18N = {
    en: {
      title: "DeadClaw Setup",
      "welcome.title": "Welcome to DeadClaw",
      "welcome.subtitle": "DeadClaw is a one-click installer for OpenClaw",
      "welcome.feat2": "OpenClaw can access files on your computer and automate tasks",
      "welcome.feat3": "Connect to WeChat, Feishu, WeCom, DingTalk, QQ Bot",
      "welcome.security": "API keys stored locally, never sent to third-party servers",
      "welcome.warning": "OpenClaw has high system privileges and can control your computer — please use it responsibly",
      "welcome.next": "Next",
      "config.title": "Configure API Key",
      "config.subtitle": "Enter your API key and choose a model",
      "config.keyNotice": "DeadClaw does not provide API keys. Please click the link to purchase one from the provider's website",
      "config.apiKey": "API Key",
      "config.getKey": "Get API Key →",
      "config.model": "Model",
      "config.docsLink": "Tutorial Docs →",
      "config.back": "Back",
      "config.verify": "Save & Continue",
      "config.loadingModels": "Validating API key and loading models…",
      "done.title": "All Set!",
      "done.subtitle": "DeadClaw is ready — switch models anytime in Settings",
      "done.launchAtLogin": "Launch at login",
      "done.start": "Start DeadClaw",
      "done.starting": "Starting Gateway…",
      "done.startFailed": "Gateway failed to start — please click Start DeadClaw to retry",
      "conflict.title": "Existing OpenClaw Detected",
      "conflict.subtitle": "OneClaw will take over this installation automatically",
      "conflict.reassure": "Your personas and chat history will be preserved",
      "conflict.portInUse": "Port {port} is in use by process: {process} (PID: {pid})",
      "conflict.globalInstalled": "Global installation found: {path}",
      "conflict.uninstall": "Uninstall old version & continue",
      "conflict.quit": "Quit",
      "conflict.uninstalling": "Uninstalling…",
      "conflict.failed": "Operation failed: ",
      "error.noKey": "Please enter your API key",
      "error.verifyFailed": "Verification failed — please check your API key",
      "error.connection": "Connection error: ",
    },
    zh: {
      title: "DeadClaw 安装引导",
      "welcome.title": "欢迎使用 DeadClaw",
      "welcome.subtitle": "DeadClaw 是 OpenClaw 的一键安装包",
      "welcome.feat2": "OpenClaw 可以访问电脑上的文件，自动执行各种办公任务",
      "welcome.feat3": "连接微信、飞书、企业微信、钉钉、QQ 机器人",
      "welcome.security": "API 密钥安全存储在本地 绝不会发送到任何第三方服务器",
      "welcome.warning": "OpenClaw 权限非常高 可以控制本地电脑 请注意使用安全",
      "welcome.next": "下一步",
      "config.title": "配置 API 密钥",
      "config.subtitle": "输入 API 密钥并选择模型",
      "config.keyNotice": "DeadClaw 不提供 API 密钥 请点击链接前往服务商官网购买 API 密钥后使用",
      "config.apiKey": "API 密钥",
      "config.getKey": "获取密钥 →",
      "config.model": "模型",
      "config.docsLink": "教程文档 →",
      "config.back": "返回",
      "config.verify": "保存并继续",
      "config.loadingModels": "正在校验 API 密钥并加载模型…",
      "done.title": "配置完成！",
      "done.subtitle": "DeadClaw 已就绪 可随时在设置中切换模型",
      "done.launchAtLogin": "开机启动",
      "done.start": "启动 DeadClaw",
      "done.starting": "正在启动 Gateway…",
      "done.startFailed": 'Gateway 启动失败 请点击"启动 DeadClaw"重试',
      "conflict.title": "检测到已安装的 OpenClaw",
      "conflict.subtitle": "OneClaw 将自动接管此安装",
      "conflict.reassure": "你的人设和聊天记录将会被保留",
      "conflict.portInUse": "端口 {port} 被占用，进程: {process} (PID: {pid})",
      "conflict.globalInstalled": "全局安装路径: {path}",
      "conflict.uninstall": "卸载旧版并继续",
      "conflict.quit": "退出",
      "conflict.uninstalling": "正在卸载…",
      "conflict.failed": "操作失败：",
      "error.noKey": "请输入 API 密钥",
      "error.verifyFailed": "验证失败 请检查 API 密钥",
      "error.connection": "连接错误：",
    },
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    progressFill: $("#progressFill"),
    steps: $$(".step"),
    btnToStep2: $("#btnToStep2"),
    platformLink: $("#platformLink"),
    docsLink: $("#docsLink"),
    apiKeyInput: $("#apiKey"),
    btnToggleKey: $("#btnToggleKey"),
    modelSelect: $("#modelSelect"),
    errorMsg: $("#errorMsg"),
    btnBackToStep1: $("#btnBackToStep1"),
    btnVerify: $("#btnVerify"),
    btnVerifyText: $("#btnVerify .btn-text"),
    btnVerifySpinner: $("#btnVerify .btn-spinner"),
    conflictPort: $("#conflictPort"),
    conflictPortText: $("#conflictPortText"),
    conflictGlobal: $("#conflictGlobal"),
    conflictGlobalText: $("#conflictGlobalText"),
    conflictError: $("#conflictError"),
    btnUninstall: $("#btnUninstall"),
    btnUninstallText: document.querySelector("#btnUninstall .btn-text"),
    btnUninstallSpinner: document.querySelector("#btnUninstall .btn-spinner"),
    btnQuitConflict: $("#btnQuitConflict"),
    btnStart: $("#btnStart"),
    btnStartText: $("#btnStart .btn-text"),
    btnStartSpinner: $("#btnStartSpinner"),
    doneStatus: $("#doneStatus"),
    launchAtLoginRow: $("#launchAtLoginRow"),
    launchAtLoginEnabled: $("#launchAtLoginEnabled"),
  };

  let currentStep = 1;
  let verifying = false;
  let starting = false;
  let currentLang = "en";
  let launchAtLoginSupported = false;
  let detectionResult = null;
  let resolving = false;
  let verifiedApiKey = "";

  function detectLang() {
    const params = new URLSearchParams(window.location.search);
    const lang = params.get("lang");
    currentLang = lang && I18N[lang] ? lang : "en";
  }

  function t(key) {
    return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
  }

  function applyI18n() {
    document.title = t("title");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
  }

  function goToStep(step) {
    currentStep = step;
    if (step === 0) {
      els.progressFill.style.width = "0%";
    } else {
      els.progressFill.style.width = `${Math.round(step * 100 / 3)}%`;
    }
    els.steps.forEach((el, i) => {
      el.classList.toggle("active", i === step);
    });
  }

  async function checkExistingInstallation() {
    if (!window.oneclaw?.detectInstallation) {
      goToStep(1);
      return;
    }
    try {
      const res = await window.oneclaw.detectInstallation();
      if (!res?.success || !res.data) {
        goToStep(1);
        return;
      }
      detectionResult = res.data;
      const hasConflict = detectionResult.portInUse || detectionResult.globalInstalled;
      if (!hasConflict) {
        goToStep(1);
        return;
      }
      if (detectionResult.portInUse) {
        els.conflictPortText.textContent = t("conflict.portInUse")
          .replace("{port}", "18789")
          .replace("{process}", detectionResult.portProcess || "unknown")
          .replace("{pid}", String(detectionResult.portPid || "?"));
        els.conflictPort.classList.remove("hidden");
      }
      if (detectionResult.globalInstalled) {
        els.conflictGlobalText.textContent = t("conflict.globalInstalled")
          .replace("{path}", detectionResult.globalPath || "openclaw");
        els.conflictGlobal.classList.remove("hidden");
      }
      goToStep(0);
    } catch {
      goToStep(1);
    }
  }

  async function handleUninstall() {
    if (resolving) return;
    resolving = true;
    setConflictBtnState(els.btnUninstall, els.btnUninstallText, els.btnUninstallSpinner, true, t("conflict.uninstalling"));
    els.btnQuitConflict.disabled = true;
    hideConflictError();

    try {
      const res = await window.oneclaw.resolveConflict({
        action: "uninstall",
        pid: detectionResult?.portPid || 0,
      });
      if (res?.success) {
        goToStep(1);
      } else {
        showConflictError(t("conflict.failed") + (res?.message || ""));
      }
    } catch (err) {
      showConflictError(t("conflict.failed") + (err.message || ""));
    } finally {
      resolving = false;
      setConflictBtnState(els.btnUninstall, els.btnUninstallText, els.btnUninstallSpinner, false, t("conflict.uninstall"));
      els.btnQuitConflict.disabled = false;
    }
  }

  function handleQuitConflict() {
    window.close();
  }

  function setConflictBtnState(btn, textEl, spinnerEl, loading, text) {
    btn.disabled = loading;
    textEl.textContent = text;
    spinnerEl.classList.toggle("hidden", !loading);
  }

  function showConflictError(msg) {
    els.conflictError.textContent = msg;
    els.conflictError.classList.remove("hidden");
  }

  function hideConflictError() {
    els.conflictError.classList.add("hidden");
    els.conflictError.textContent = "";
  }

  function initializeProviderForm() {
    els.apiKeyInput.placeholder = FIXED_PROVIDER.placeholder;
    els.platformLink.textContent = t("config.getKey");
    els.platformLink.dataset.url = FIXED_PROVIDER.platformUrl;
    els.platformLink.classList.remove("hidden");
    populateModels([]);
    els.modelSelect.disabled = true;
    els.btnVerify.disabled = true;
  }

  function populateModels(models) {
    els.modelSelect.innerHTML = "";
    models.forEach((m) => {
      const opt = document.createElement("option");
      const model = typeof m === "string" ? { id: m, name: m } : m;
      opt.value = model.id;
      opt.textContent = model.name || model.id;
      els.modelSelect.appendChild(opt);
    });
  }

  function resetModelState() {
    verifiedApiKey = "";
    populateModels([]);
    els.modelSelect.disabled = true;
    els.btnVerify.disabled = true;
  }

  let loadModelsTimer = null;

  async function loadModelsForApiKey(apiKey) {
    if (!apiKey) {
      resetModelState();
      hideError();
      return;
    }
    setVerifying(true, t("config.loadingModels"));
    hideError();
    try {
      const result = await window.oneclaw.setupListAvailableModels({ apiKey });
      if (!result?.success) {
        resetModelState();
        showError(result?.message || t("error.verifyFailed"));
        return;
      }
      const models = Array.isArray(result?.data?.models) ? result.data.models : [];
      if (!models.length) {
        resetModelState();
        showError(t("error.verifyFailed"));
        return;
      }
      verifiedApiKey = apiKey;
      populateModels(models);
      els.modelSelect.disabled = false;
      els.btnVerify.disabled = false;
    } catch (err) {
      resetModelState();
      showError(t("error.connection") + (err.message || "Unknown error"));
    } finally {
      setVerifying(false);
    }
  }

  function toggleKeyVisibility() {
    const input = els.apiKeyInput;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";

    const eyeOn = els.btnToggleKey.querySelector(".icon-eye");
    const eyeOff = els.btnToggleKey.querySelector(".icon-eye-off");
    eyeOn.classList.toggle("hidden", !isPassword);
    eyeOff.classList.toggle("hidden", isPassword);
  }

  async function handleVerify() {
    if (verifying) return;

    const apiKey = els.apiKeyInput.value.trim();
    if (!apiKey) {
      showError(t("error.noKey"));
      return;
    }
    if (verifiedApiKey !== apiKey) {
      showError(t("error.verifyFailed"));
      return;
    }
    if (!els.modelSelect.value) {
      showError(t("error.verifyFailed"));
      return;
    }

    const params = buildParams(apiKey);
    setVerifying(true);
    hideError();

    try {
      await window.oneclaw.saveConfig(buildSavePayload(params));
      setVerifying(false);
      goToStep(3);
    } catch (err) {
      showError(t("error.connection") + (err.message || "Unknown error"));
      setVerifying(false);
    }
  }

  function buildParams(apiKey) {
    return {
      provider: FIXED_PROVIDER.provider,
      apiKey,
      modelID: els.modelSelect.value,
      baseURL: FIXED_PROVIDER.baseUrl,
      api: FIXED_PROVIDER.api,
      supportImage: true,
    };
  }

  function buildSavePayload(params) {
    return {
      provider: params.provider,
      apiKey: params.apiKey,
      modelID: params.modelID,
      baseURL: FIXED_PROVIDER.baseUrl,
      api: FIXED_PROVIDER.api,
      subPlatform: "",
      supportImage: true,
      customPreset: "",
    };
  }

  async function handleComplete() {
    if (starting) return;
    setStarting(true);
    setDoneStatus("");

    try {
      const payload = {
        installCli: true,
        sessionMemory: true,
      };
      if (launchAtLoginSupported) {
        payload.launchAtLogin = !!els.launchAtLoginEnabled.checked;
      }
      const result = await window.oneclaw.completeSetup(payload);
      if (!result || !result.success) {
        setStarting(false);
        setDoneStatus(result?.message || t("done.startFailed"), true);
      }
    } catch (err) {
      setStarting(false);
      setDoneStatus((err && err.message) || t("done.startFailed"), true);
    }
  }

  async function loadLaunchAtLoginState() {
    if (!window.oneclaw?.setupGetLaunchAtLogin) {
      return;
    }
    try {
      const result = await window.oneclaw.setupGetLaunchAtLogin();
      if (!result?.success || !result.data) {
        return;
      }
      launchAtLoginSupported = result.data.supported === true;
      toggleEl(els.launchAtLoginRow, launchAtLoginSupported);
      if (launchAtLoginSupported) {
        els.launchAtLoginEnabled.checked = true;
      }
    } catch {
      launchAtLoginSupported = false;
    }
  }

  function toggleEl(el, show) {
    if (!el) return;
    el.classList.toggle("hidden", !show);
  }

  function showError(msg) {
    els.errorMsg.textContent = msg;
    els.errorMsg.classList.remove("hidden");
  }

  function hideError() {
    els.errorMsg.classList.add("hidden");
    els.errorMsg.textContent = "";
  }

  function setVerifying(loading, text) {
    verifying = loading;
    els.btnVerify.disabled = loading || !verifiedApiKey || !els.modelSelect.value;
    els.btnVerifyText.textContent = loading ? (text || t("config.verify")) : t("config.verify");
    els.btnVerifyText.classList.toggle("hidden", false);
    els.btnVerifySpinner.classList.toggle("hidden", !loading);
  }

  function setStarting(loading) {
    starting = loading;
    els.btnStart.disabled = loading;
    if (loading) {
      els.btnStartText.textContent = t("done.starting");
      els.btnStartSpinner.classList.remove("hidden");
    } else {
      els.btnStartText.textContent = t("done.start");
      els.btnStartSpinner.classList.add("hidden");
    }
  }

  function setDoneStatus(msg, isError) {
    if (!msg) {
      els.doneStatus.classList.add("hidden");
      els.doneStatus.classList.remove("error");
      els.doneStatus.textContent = "";
      return;
    }
    els.doneStatus.textContent = msg;
    els.doneStatus.classList.remove("hidden");
    els.doneStatus.classList.toggle("error", !!isError);
  }

  function bindEvents() {
    els.btnUninstall.addEventListener("click", handleUninstall);
    els.btnQuitConflict.addEventListener("click", handleQuitConflict);
    els.btnToStep2.addEventListener("click", () => goToStep(2));
    els.btnBackToStep1.addEventListener("click", () => goToStep(1));

    els.platformLink.addEventListener("click", (e) => {
      e.preventDefault();
      const url = els.platformLink.dataset.url;
      if (url && window.oneclaw?.openExternal) {
        window.oneclaw.openExternal(url);
      }
    });

    els.docsLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.oneclaw?.openExternal) {
        window.oneclaw.openExternal(FIXED_PROVIDER.docsUrl);
      }
    });

    els.btnToggleKey.addEventListener("click", toggleKeyVisibility);
    els.apiKeyInput.addEventListener("input", () => {
      const apiKey = els.apiKeyInput.value.trim();
      resetModelState();
      if (loadModelsTimer) {
        clearTimeout(loadModelsTimer);
      }
      if (apiKey) {
        loadModelsTimer = setTimeout(() => {
          loadModelsTimer = null;
          loadModelsForApiKey(apiKey);
        }, 350);
      } else {
        hideError();
      }
    });
    els.modelSelect.addEventListener("change", () => {
      els.btnVerify.disabled = verifying || !verifiedApiKey || !els.modelSelect.value;
    });
    els.btnVerify.addEventListener("click", handleVerify);
    els.apiKeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !els.btnVerify.disabled) handleVerify();
    });
    els.btnStart.addEventListener("click", handleComplete);
  }

  function init() {
    detectLang();
    applyI18n();
    initializeProviderForm();
    bindEvents();
    checkExistingInstallation();
    loadLaunchAtLoginState();
  }

  init();
})();
