(() => {
  const windowLabel = __MYAGENTS_WINDOW_LABEL__;
  const describeError = (value) => {
    try {
      if (value && typeof value === 'object') {
        const name = typeof value.name === 'string' ? value.name : 'Error';
        const message = typeof value.message === 'string' ? value.message : String(value);
        const stack = typeof value.stack === 'string' ? `\n${value.stack}` : '';
        return `${name}: ${message}${stack}`.slice(0, 2000);
      }
      return String(value).slice(0, 2000);
    } catch {
      return 'unprintable error';
    }
  };
  const report = (stage, detail) => {
    try {
      const internals = globalThis.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') return;
      void internals.invoke('cmd_record_renderer_boot_event', {
        stage,
        windowLabel,
        detail,
      }).catch(() => {});
    } catch {
      // Diagnostics must never become a startup dependency.
    }
  };

  if (!globalThis.__MYAGENTS_BOOT_OBSERVABILITY_INSTALLED__ && typeof globalThis.addEventListener === 'function') {
    globalThis.__MYAGENTS_BOOT_OBSERVABILITY_INSTALLED__ = true;
    globalThis.addEventListener('error', (event) => {
      const source = event.filename ? ` source=${event.filename}:${event.lineno}:${event.colno}` : '';
      report('renderer-uncaught-error', `${source} error=${describeError(event.error ?? event.message)}`);
    });
    globalThis.addEventListener('unhandledrejection', (event) => {
      report('renderer-unhandled-rejection', `error=${describeError(event.reason)}`);
    });
  }
  report('native-init-script');

  try {
    const key = 'myagents:theme-bootstrap';
    const runKey = 'myagents:theme-native-bootstrap-run';
    const runId = __MYAGENTS_BOOTSTRAP_RUN_ID__;
    if (localStorage.getItem(runKey) === runId) {
      report('theme-native-bootstrap-skipped');
      return;
    }

    let themeId = 'myagents-light';
    let themeSelectionExplicit = false;
    const raw = localStorage.getItem(key);

    if (raw) {
      try {
        const snapshot = JSON.parse(raw);
        if (
          snapshot
          && (snapshot.version === 1 || snapshot.version === 2)
        ) {
          const storedThemeId = typeof snapshot.themeId === 'string'
            ? snapshot.themeId.trim()
            : '';
          themeSelectionExplicit = snapshot.version === 2
            ? snapshot.themeSelectionExplicit === true && storedThemeId !== ''
            : storedThemeId !== '' && storedThemeId !== 'myagents-default';
          if (themeSelectionExplicit) themeId = storedThemeId;
        }
      } catch {
        // A damaged snapshot must not prevent durable appearance alignment.
      }
    }

    localStorage.setItem(key, JSON.stringify({
      version: 2,
      themeId,
      appearanceMode: __MYAGENTS_APPEARANCE_MODE__,
      themeSelectionExplicit,
    }));
    // initialization_script runs again on reload. Mark this native process
    // only after the snapshot write succeeds, so a reload cannot overwrite a
    // newer appearance already published by ThemeRuntime.
    localStorage.setItem(runKey, runId);
    localStorage.removeItem('theme');
    report('theme-native-bootstrap-complete');
  } catch (error) {
    report('theme-native-bootstrap-failed', `error=${describeError(error)}`);
    // Private-mode or disabled storage must never block native startup.
  }
})();
