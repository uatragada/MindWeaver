# Legacy temp cleanup

This adapter is scoped to `temp`, used by electron-winstaller. That package needs
rimraf's callback and synchronous APIs to remove tracked literal temporary paths.
Node's `fs.rm` provides the removal and retry behavior without the old glob and
minimatch internals. `maxBusyTries` maps to `maxRetries`.

It deliberately supports literal paths only. Do not use it as a general rimraf
replacement or extend the override to other consumers. Keep the integration
tests against the installed `temp` package when updating the packaging tools.
