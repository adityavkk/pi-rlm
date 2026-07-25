# Public Pi acceptance boundary

Pinned Pi version: `@earendil-works/pi-coding-agent` 0.80.10.

Credential-free integration tests use only public exports: `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`, `AgentSession.bindExtensions()`, and `AgentSession.prompt()`. They run the real `AgentSession` and `ExtensionRunner` command path in `tui`, `rpc`, `json`, and `print` extension modes, inject the extension's public `executeRun` seam, and verify source capture plus the persisted `pi-rlm-result` custom-message entry. No provider call or credential is used.

Pinned limitation: `runRpcMode()` owns process stdin/stdout and has return type `Promise<never>`; `runPrintMode()` and `InteractiveMode.run()` own mode lifecycle/output. None accepts an extension-runtime or `executeRun` injection. Therefore the credential-free in-process acceptance uses the public SDK runner and mode binding rather than private mode internals. Packed-install smoke separately verifies CLI/package discovery. Also, `ExtensionAPI.sendMessage()` returns `void`, so Pi 0.80.10 exposes no awaited message-persistence acknowledgement to extensions.
