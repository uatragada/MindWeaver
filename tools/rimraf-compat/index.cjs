const { rm, rmSync } = require("node:fs");

function cleanupOptions(options = {}) {
  return {
    recursive: true,
    force: true,
    maxRetries: options.maxBusyTries ?? 3
  };
}

function rimraf(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  rm(path, cleanupOptions(options), callback);
}

rimraf.sync = (path, options) => rmSync(path, cleanupOptions(options));

module.exports = rimraf;
