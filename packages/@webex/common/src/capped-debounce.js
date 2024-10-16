/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

/**
 * Behaves like debounce, but additionally executes after a number of calls are
 * attempted, rather than just time
 * @param {Function} fn
 * @param {Number} wait
 * @param {Object} options
 * @returns {Function}
 */
export default function debounce(fn, wait, options) {
  /* eslint no-invalid-this: [0] */

  if (!fn) {
    throw new Error('`fn` must be a function');
  }

  if (!wait) {
    throw new Error('`wait` is required');
  }

  options = options || {};
  if (!options.maxWait) {
    throw new Error('`options.maxWait` is required');
  }
  if (!options.maxCalls) {
    throw new Error('`options.maxCalls` is required');
  }

  const {maxCalls, maxWait} = options;
  let count = 0;
  let maxWaitTimer, waitTimer;

  return function wrapper() {
    count += 1;

    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => exec(), wait);

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => exec(), maxWait);
    }

    if (count >= maxCalls) {
      Reflect.apply(exec, this, []);
    }
  };

  /**
   * @private
   * @returns {undefined}
   */
  function exec() {
    clearTimeout(waitTimer);
    waitTimer = null;
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
    count = 0;

    Reflect.apply(fn, this, []);
  }
}
