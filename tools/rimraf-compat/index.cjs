const { rm, rmSync } = require("node:fs");

/**
 * Maps temp's legacy busy-file retry option to Node's removal options.
 * @param {{maxBusyTries?: number}} [options] Options supplied by temp.
 * @returns {object} Options for removing a tracked literal path.
 */
function cleanupOptions(options = {}) {
  return {
    recursive: true,
    force: true,
    maxRetries: options.maxBusyTries ?? 3
  };
}

/**
 * Removes one literal path tracked by temp, preserving its callback API.
 * This scoped adapter does not expand glob patterns.
 * @param {string} path Tracked temporary file or directory.
 * @param {object|Function} options Retry options or the completion callback.
 * @param {Function} [callback] Called when removal finishes or fails.
 * @returns {void}
 */
function rimraf(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  rm(path, cleanupOptions(options), callback);
}

rimraf.sync = (path, options) => rmSync(path, cleanupOptions(options));

module.exports = rimraf;
