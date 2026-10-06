/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import {inBrowser, patterns} from '@webex/common';
import {WebexPlugin} from '@webex/webex-core';
import {cloneDeep, has, isArray, isObject, isString} from 'lodash';

const precedence = {
  silent: 0,
  group: 1,
  groupEnd: 2,
  error: 3,
  warn: 4,
  log: 5,
  info: 6,
  debug: 7,
  trace: 8,
};

export const levels = Object.keys(precedence).filter((level) => level !== 'silent');

const fallbacks = {
  error: ['log'],
  warn: ['error', 'log'],
  info: ['log'],
  debug: ['info', 'log'],
  trace: ['debug', 'info', 'log'],
};

const LOG_TYPES = {
  SDK: 'sdk',
  CLIENT: 'client',
};

const SDK_LOG_TYPE_NAME = 'wx-js-sdk';

const authTokenKeyPattern = /[Aa]uthorization/;

const BUFFERED_LOG_METADATA = Symbol('bufferedLogMetadata');
const LOG_METHOD_CONTROL = Symbol('logMethodControl');
const loggerStates = new WeakMap();
const bufferStates = new WeakMap();
const recordTextEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : undefined;

const METADATA_LIMITS = {
  eventName: 128,
  attributes: 8,
  attributeKey: 64,
  attributeStringValue: 256,
};

/**
 * Gets private sequence and transport state for a logger instance.
 * @param {Logger} logger logger instance
 * @returns {Object} logger state
 */
function getLoggerState(logger) {
  if (!loggerStates.has(logger)) {
    loggerStates.set(logger, {
      nextSequence: 1,
      transports: new Map(),
    });
  }

  return loggerStates.get(logger);
}

/**
 * Gets the absolute position of the oldest retained entry in a physical buffer.
 * @param {Object} bufferRef physical buffer container
 * @returns {Object} buffer position state
 */
function getBufferState(bufferRef) {
  if (!bufferStates.has(bufferRef)) {
    bufferStates.set(bufferRef, {basePosition: 0});
  }

  return bufferStates.get(bufferRef);
}

/**
 * @param {Logger} logger logger instance
 * @returns {Array<Object>} all physical buffer containers
 */
function getPhysicalBuffers(logger) {
  return [logger.buffer, logger.sdkBuffer, logger.clientBuffer];
}

/**
 * @param {Logger} logger logger instance
 * @returns {Array<Object>} currently configured physical buffer containers
 */
function getActiveBuffers(logger) {
  if (logger.config.separateLogBuffers) {
    return [logger.sdkBuffer, logger.clientBuffer];
  }

  return [logger.buffer];
}

/**
 * Creates the lazy transport view without changing the retained entry.
 * @param {Array<mixed>} entry retained legacy log entry
 * @returns {Object} generic transport record
 */
function makeTransportRecord(entry) {
  const [sequence, source, level, eventName, attributes] = entry[BUFFERED_LOG_METADATA];
  const record = {
    sequence,
    timestamp: entry[1],
    level,
    source,
    body: entry.toString(),
  };

  if (eventName) {
    record.eventName = eventName;
  }
  if (attributes) {
    record.attributes = attributes;
  }

  return record;
}

/**
 * @param {Object} record generic transport record
 * @returns {number} estimated serialized bytes
 */
function estimateRecordBytes(record) {
  const serialized = JSON.stringify(record);

  if (recordTextEncoder) {
    return recordTextEncoder.encode(serialized).byteLength;
  }

  return serialized.length;
}

/**
 * Clamps one transport cursor to retained history and reports the lost delta.
 * @param {Object} registration transport registration
 * @param {Object} bufferRef physical buffer container
 * @returns {Object} mutable selection state
 */
function prepareBufferForSelection(registration, bufferRef) {
  const {basePosition} = getBufferState(bufferRef);
  const originalCursor = registration.cursors.get(bufferRef);
  const dropped = Math.max(0, basePosition - originalCursor);
  const cursor = Math.max(basePosition, originalCursor);

  registration.cursors.set(bufferRef, cursor);

  return {
    bufferRef,
    cursor,
    index: cursor - basePosition,
    dropped,
  };
}

/**
 * Selects one byte-bounded batch in the same order as formatLogs().
 * @param {Logger} logger logger instance
 * @param {Object} registration transport registration
 * @param {number} maxEstimatedBytes estimated byte limit
 * @returns {Object} selected records and acknowledgement positions
 */
function selectTransportBatch(logger, registration, maxEstimatedBytes) {
  const activeBuffers = getActiveBuffers(logger);
  const selections = activeBuffers.map((bufferRef) =>
    prepareBufferForSelection(registration, bufferRef)
  );
  const records = [];
  const selectedEnds = new Map();
  let estimatedBytes = 0;

  /** @returns {Object|undefined} next buffer selection in legacy order */
  function nextSelection() {
    if (!logger.config.separateLogBuffers) {
      return selections[0].index < selections[0].bufferRef.buffer.length
        ? selections[0]
        : undefined;
    }

    const [sdkSelection, clientSelection] = selections;
    const sdkEntry = sdkSelection.bufferRef.buffer[sdkSelection.index];
    const clientEntry = clientSelection.bufferRef.buffer[clientSelection.index];

    if (sdkEntry && (!clientEntry || new Date(sdkEntry[1]) <= new Date(clientEntry[1]))) {
      return sdkSelection;
    }

    return clientEntry ? clientSelection : undefined;
  }

  let selection = nextSelection();

  while (selection) {
    const entry = selection.bufferRef.buffer[selection.index];
    const record = makeTransportRecord(entry);
    const recordBytes = estimateRecordBytes(record);

    if (records.length > 0 && estimatedBytes + recordBytes > maxEstimatedBytes) {
      break;
    }

    records.push(record);
    estimatedBytes += recordBytes;
    selection.index += 1;
    selection.cursor += 1;
    selectedEnds.set(selection.bufferRef, selection.cursor);
    selection = nextSelection();
  }

  return {
    activeBuffers,
    dropped: selections.reduce((count, selectedBuffer) => count + selectedBuffer.dropped, 0),
    records,
    selectedEnds,
  };
}

/**
 * @param {Object} registration transport registration
 * @param {Array<Object>} activeBuffers physical buffers included in the flush
 * @returns {number} retained records after the effective cursor
 */
function countRemaining(registration, activeBuffers) {
  return activeBuffers.reduce((count, bufferRef) => {
    const {basePosition} = getBufferState(bufferRef);
    const cursor = Math.max(basePosition, registration.cursors.get(bufferRef));
    const end = basePosition + bufferRef.buffer.length;

    return count + Math.max(0, end - cursor);
  }, 0);
}

/**
 * Applies existing redaction and generic metadata bounds.
 * @param {Logger} logger logger instance
 * @param {Object} metadata untrusted event metadata
 * @returns {Object|undefined} bounded metadata
 */
function sanitizeLogMetadata(logger, metadata) {
  if (!metadata || typeof metadata !== 'object' || isArray(metadata)) {
    return undefined;
  }

  try {
    const [filtered] = logger.filter(metadata);
    const eventName = isString(filtered.eventName)
      ? filtered.eventName.slice(0, METADATA_LIMITS.eventName)
      : undefined;
    const attributeEntries = [];

    if (
      filtered.attributes &&
      typeof filtered.attributes === 'object' &&
      !isArray(filtered.attributes)
    ) {
      Object.entries(filtered.attributes).some(([key, value]) => {
        if (attributeEntries.length >= METADATA_LIMITS.attributes) {
          return true;
        }
        if (!key || key.length > METADATA_LIMITS.attributeKey) {
          return false;
        }
        if (isString(value)) {
          attributeEntries.push([key, value.slice(0, METADATA_LIMITS.attributeStringValue)]);
        } else if (
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        ) {
          attributeEntries.push([key, value]);
        }

        return false;
      });
    }

    if (!eventName && attributeEntries.length === 0) {
      return undefined;
    }

    return {
      eventName,
      attributes: attributeEntries.length > 0 ? Object.fromEntries(attributeEntries) : undefined,
    };
  } catch (error) {
    return undefined;
  }
}

/**
 * Recursively strips "authorization" fields from the specified object
 * @param {Object} object
 * @param {Array<mixed>} [visited]
 * @private
 * @returns {Object}
 */
function walkAndFilter(object, visited = []) {
  if (visited.includes(object)) {
    // Prevent circular references
    return object;
  }

  visited.push(object);

  if (isArray(object)) {
    return object.map((o) => walkAndFilter(o, visited));
  }
  if (!isObject(object)) {
    if (isString(object)) {
      if (patterns.containsEmails.test(object)) {
        return object.replace(patterns.containsEmails, '[REDACTED]');
      }
      if (patterns.containsMTID.test(object)) {
        return object.replace(patterns.containsMTID, '$1[REDACTED]');
      }
    }

    return object;
  }

  for (const [key, value] of Object.entries(object)) {
    if (authTokenKeyPattern.test(key)) {
      Reflect.deleteProperty(object, key);
    } else {
      object[key] = walkAndFilter(value, visited);
    }
  }

  return object;
}

/**
 * @class
 */
const Logger = WebexPlugin.extend({
  namespace: 'Logger',

  derived: {
    level: {
      cache: false,
      fn() {
        return this.getCurrentLevel();
      },
    },
    client_level: {
      cache: false,
      fn() {
        return this.getCurrentClientLevel();
      },
    },
  },
  session: {
    // for when configured to use single buffer
    buffer: {
      type: 'object',
      default() {
        return {
          buffer: [],
          nextIndex: 0,
        };
      },
    },
    groupLevel: {
      type: 'number',
      default() {
        return 0;
      },
    },
    // for when configured to use separate buffers
    sdkBuffer: {
      type: 'object',
      default() {
        return {
          buffer: [],
          nextIndex: 0,
        };
      },
    },
    clientBuffer: {
      type: 'object',
      default() {
        return {
          buffer: [],
          nextIndex: 0,
        };
      },
    },
  },

  /**
   * Ensures auth headers don't get printed in logs
   * @param {Array<mixed>} args
   * @private
   * @memberof Logger
   * @returns {Array<mixed>}
   */
  filter(...args) {
    return args.map((arg) => {
      // WebexHttpError already ensures auth tokens don't get printed, so, no
      // need to alter it here.
      if (arg instanceof Error) {
        // karma logs won't print subclassed errors correctly, so we need
        // explicitly call their tostring methods.
        if (process.env.NODE_ENV === 'test' && inBrowser) {
          let ret = arg.toString();

          ret += 'BEGIN STACK';
          ret += arg.stack;
          ret += 'END STACK';

          return ret;
        }

        return arg;
      }

      arg = cloneDeep(arg);

      return walkAndFilter(arg);
    });
  },

  /**
   * Determines if the current level allows logs at the specified level to be
   * printed
   * @param {string} level
   * @param {string} type type of log, SDK or client
   * @private
   * @memberof Logger
   * @returns {boolean}
   */
  shouldPrint(level, type = LOG_TYPES.SDK) {
    return (
      precedence[level] <=
      precedence[type === LOG_TYPES.SDK ? this.getCurrentLevel() : this.getCurrentClientLevel()]
    );
  },

  /**
   * Determines if the current level allows logs at the specified level to be
   * put into the log buffer. We're configuring it omit trace and debug logs
   * because there are *a lot* of debug logs that really don't provide value at
   * runtime (they're helpful for debugging locally, but really just pollute the
   * uploaded logs and push useful info out).
   * @param {string} level
   * @param {string} type type of log, SDK or client
   * @private
   * @memberof Logger
   * @returns {boolean}
   */
  shouldBuffer(level) {
    return (
      precedence[level] <=
      (this.config.bufferLogLevel ? precedence[this.config.bufferLogLevel] : precedence.info)
    );
  },

  /**
   * Indicates the current SDK log level based on env vars, feature toggles, and
   * user type.
   * @instance
   * @memberof Logger
   * @private
   * @memberof Logger
   * @returns {string}
   */
  // eslint-disable-next-line complexity
  getCurrentLevel() {
    // If a level has been explicitly set via config, alway use it.
    if (this.config.level) {
      return this.config.level;
    }

    if (levels.includes(process.env.WEBEX_LOG_LEVEL)) {
      return process.env.WEBEX_LOG_LEVEL;
    }

    // Always use debug-level logging in test mode;
    if (process.env.NODE_ENV === 'test') {
      return 'trace';
    }

    // Use server-side-feature toggles to configure log levels
    const level =
      this.webex.internal.device && this.webex.internal.device.features.developer.get('log-level');

    if (level) {
      if (levels.includes(level)) {
        return level;
      }
    }

    return 'error';
  },

  /**
   * Indicates the current client log level based on config, defaults to SDK level
   * @instance
   * @memberof Logger
   * @private
   * @memberof Logger
   * @returns {string}
   */
  getCurrentClientLevel() {
    // If a client log level has been explicitly set via config, alway use it.
    if (this.config.clientLevel) {
      return this.config.clientLevel;
    }

    // otherwise default to SDK level
    return this.getCurrentLevel();
  },

  /**
   * Format logs (for upload)
   *
   * If separate client, SDK buffers is configured, merge the buffers, if configured
   *
   * @instance
   * @memberof Logger
   * @public
   * @memberof Logger
   * @param {Object} options
   * @param {boolean} options.diff whether to only format the diff from last call to formatLogs(), false by default
   * @returns {string} formatted buffer
   */
  formatLogs(options = {}) {
    function getDate(log) {
      return log[1];
    }
    const {diff = false} = options;
    let buffer = [];
    let clientIndex = diff ? this.clientBuffer.nextIndex : 0;
    let sdkIndex = diff ? this.sdkBuffer.nextIndex : 0;

    if (this.config.separateLogBuffers) {
      // merge the client and sdk buffers
      // while we have entries in either buffer
      while (
        clientIndex < this.clientBuffer.buffer.length ||
        sdkIndex < this.sdkBuffer.buffer.length
      ) {
        // if we have remaining entries in the SDK buffer
        if (
          sdkIndex < this.sdkBuffer.buffer.length &&
          // and we haven't exhausted all the client buffer entries, or SDK date is before client date
          (clientIndex >= this.clientBuffer.buffer.length ||
            new Date(getDate(this.sdkBuffer.buffer[sdkIndex])) <=
              new Date(getDate(this.clientBuffer.buffer[clientIndex])))
        ) {
          // then add to the SDK buffer
          buffer.push(this.sdkBuffer.buffer[sdkIndex]);
          sdkIndex += 1;
        }
        // otherwise if we haven't exhausted all the client buffer entries, add client entry, whether it was because
        // it was the only remaining entries or date was later (the above if)
        else if (clientIndex < this.clientBuffer.buffer.length) {
          buffer.push(this.clientBuffer.buffer[clientIndex]);
          clientIndex += 1;
        }
      }
      if (diff) {
        this.clientBuffer.nextIndex = clientIndex;
        this.sdkBuffer.nextIndex = sdkIndex;
      }
    } else if (diff) {
      buffer = this.buffer.buffer.slice(this.buffer.nextIndex);
      this.buffer.nextIndex = this.buffer.buffer.length;
    } else {
      buffer = this.buffer.buffer;
    }

    return buffer.join('\n');
  },

  /**
   * Registers optional consumers of the retained log history.
   * @param {Array<Object>} transports transports with a send(records) method
   * @returns {undefined}
   */
  registerTransports(transports) {
    if (transports === undefined || transports === null) {
      return;
    }
    if (!isArray(transports)) {
      throw new TypeError('Logger transports must be provided as an array');
    }

    const state = getLoggerState(this);

    transports.forEach((transport) => {
      if (transport === undefined || transport === null) {
        return;
      }
      if (typeof transport.send !== 'function') {
        throw new TypeError('Logger transport must implement send(records)');
      }
      if (state.transports.has(transport)) {
        return;
      }

      const cursors = new Map();

      getPhysicalBuffers(this).forEach((bufferRef) => {
        cursors.set(bufferRef, getBufferState(bufferRef).basePosition);
      });
      state.transports.set(transport, {cursors, inFlight: undefined, unreportedDropped: 0});
    });
  },

  /**
   * Sends the next bounded batch to a registered transport.
   * @param {Object} transport registered transport
   * @param {Object} options flush options
   * @param {number} options.maxEstimatedBytes estimated batch byte limit
   * @returns {Promise<Object>} per-call exported, remaining, and dropped counts
   */
  flushTransport(transport, options = {}) {
    const registration = getLoggerState(this).transports.get(transport);

    if (!registration) {
      return Promise.reject(new TypeError('Logger transport is not registered'));
    }
    if (registration.inFlight) {
      return registration.inFlight;
    }

    const maxEstimatedBytes =
      Number.isFinite(options.maxEstimatedBytes) && options.maxEstimatedBytes > 0
        ? options.maxEstimatedBytes
        : Infinity;
    const flush = Promise.resolve().then(() => {
      const batch = selectTransportBatch(this, registration, maxEstimatedBytes);

      registration.unreportedDropped += batch.dropped;

      if (batch.records.length === 0) {
        const dropped = registration.unreportedDropped;

        registration.unreportedDropped = 0;

        return {
          exported: 0,
          remaining: countRemaining(registration, batch.activeBuffers),
          dropped,
        };
      }

      return Promise.resolve()
        .then(() => transport.send(batch.records))
        .then(() => {
          const dropped = registration.unreportedDropped;

          batch.selectedEnds.forEach((selectedEnd, bufferRef) => {
            registration.cursors.set(
              bufferRef,
              Math.max(registration.cursors.get(bufferRef), selectedEnd)
            );
          });
          registration.unreportedDropped = 0;

          return {
            exported: batch.records.length,
            remaining: countRemaining(registration, batch.activeBuffers),
            dropped,
          };
        });
    });

    registration.inFlight = flush.finally(() => {
      registration.inFlight = undefined;
    });

    return registration.inFlight;
  },

  /**
   * Adds a client log with optional generic event metadata.
   * @param {string} level existing logger level
   * @param {Object} metadata eventName and scalar attributes
   * @param {Object} options append options
   * @param {Array<mixed>} args log arguments
   * @returns {undefined}
   */
  client_logWithMetadata(level, metadata, options, ...args) {
    if (!levels.includes(level)) {
      return;
    }

    const control = {
      metadata: sanitizeLogMetadata(this, metadata),
      bufferOnly: Boolean(options && options.bufferOnly),
    };

    this[`client_${level}`]({[LOG_METHOD_CONTROL]: control}, ...args);
  },
});

/**
 * Creates a logger method
 *
 *
 * @param {string} level level to create (info, error, warn, etc.)
 * @param {string} impl the level to use when writing to console
 * @param {string} type type of log, SDK or client
 * @param {bool} neverPrint function never prints to console
 * @param {bool} alwaysBuffer function always logs to log buffer
 * @instance
 * @memberof Logger
 * @private
 * @memberof Logger
 * @returns {function} logger method with specified params
 */
function makeLoggerMethod(level, impl, type, neverPrint = false, alwaysBuffer = false) {
  // Much of the complexity in the following function is due to a test-mode-only
  // helper
  return function wrappedConsoleMethod(...args) {
    let control;

    // it would be easier to just pass in the name and buffer here, but the config isn't completely initialized
    // in Ampersand, even if the initialize method is used to set this up.  so we keep the type to achieve
    // a sort of late binding to allow retrieving a name from config.
    const logType = type;
    const clientName =
      logType === LOG_TYPES.SDK ? SDK_LOG_TYPE_NAME : this.config.clientName || logType;

    let bufferRef;
    let historyLength;

    if (this.config.separateLogBuffers) {
      historyLength = this.config.clientHistoryLength
        ? this.config.clientHistoryLength
        : this.config.historyLength;
      bufferRef = logType === LOG_TYPES.SDK ? this.sdkBuffer : this.clientBuffer;
    } else {
      bufferRef = this.buffer;
      historyLength = this.config.historyLength;
    }

    try {
      if (args[0] && args[0][LOG_METHOD_CONTROL]) {
        control = args.shift()[LOG_METHOD_CONTROL];
      }

      const shouldPrint = !neverPrint && !control?.bufferOnly && this.shouldPrint(level, logType);
      const shouldBuffer = alwaysBuffer || control?.bufferOnly || this.shouldBuffer(level);

      if (!shouldBuffer && !shouldPrint) {
        return;
      }

      const filtered = [clientName, ...this.filter(...args)];
      const stringified = filtered.map((item) => {
        if (item instanceof Error) {
          return item.toString();
        }
        if (typeof item === 'object') {
          let cache = [];
          let returnItem;
          try {
            returnItem = JSON.stringify(item, (_key, value) => {
              if (typeof value === 'object' && value !== null) {
                if (cache.includes(value)) {
                  // Circular reference found, discard key
                  return undefined;
                }
                // Store value in our collection
                cache.push(value);
              }

              return value;
            });
          } catch (e) {
            returnItem = `Failed to stringify: ${item}`;
          }
          cache = null;

          return returnItem;
        }

        return item;
      });

      if (shouldPrint) {
        // when logging an object in browsers, we tend to get a dynamic
        // reference, thus going back to look at the logged value doesn't
        // necessarily show the state at log time, thus we print the stringified
        // value.
        const toPrint = inBrowser ? stringified : filtered;

        /* istanbul ignore if */
        if (process.env.NODE_ENV === 'test' && has(this, 'webex.internal.device.url')) {
          toPrint.unshift(this.webex.internal.device.url.slice(-3));
        }
        // eslint-disable-next-line no-console
        console[impl](...toPrint);
      }

      if (shouldBuffer) {
        const logDate = new Date();

        stringified.unshift(logDate.toISOString());
        stringified.unshift('|  '.repeat(this.groupLevel));
        const loggerState = getLoggerState(this);
        const metadata = control?.metadata;
        const metadataTuple = [loggerState.nextSequence, logType, level];

        if (metadata?.eventName || metadata?.attributes) {
          metadataTuple.push(metadata.eventName, metadata.attributes);
        }
        Object.defineProperty(stringified, BUFFERED_LOG_METADATA, {value: metadataTuple});
        loggerState.nextSequence += 1;
        bufferRef.buffer.push(stringified);
        if (bufferRef.buffer.length > historyLength) {
          // we've gone over the buffer limit, trim it down
          const deleteCount = bufferRef.buffer.length - historyLength;

          bufferRef.buffer.splice(0, deleteCount);
          getBufferState(bufferRef).basePosition += deleteCount;

          // and adjust the corresponding buffer index used for log diff uploads
          bufferRef.nextIndex -= deleteCount;
          if (bufferRef.nextIndex < 0) {
            bufferRef.nextIndex = 0;
          }
        }
        if (level === 'group') this.groupLevel += 1;
        if (level === 'groupEnd' && this.groupLevel > 0) this.groupLevel -= 1;
      }
    } catch (reason) {
      if (!neverPrint) {
        /* istanbul ignore next */
        // eslint-disable-next-line no-console
        console.warn(`failed to execute Logger#${level}`, reason);
      }
    }
  };
}

levels.forEach((level) => {
  let impls = fallbacks[level];
  let impl = level;

  if (impls) {
    impls = impls.slice();
    // eslint-disable-next-line no-console
    while (!console[impl]) {
      impl = impls.pop();
    }
  }

  // eslint-disable-next-line complexity
  Logger.prototype[`client_${level}`] = makeLoggerMethod(level, impl, LOG_TYPES.CLIENT);
  Logger.prototype[level] = makeLoggerMethod(level, impl, LOG_TYPES.SDK);
});

Logger.prototype.client_logToBuffer = makeLoggerMethod(
  'info',
  'info',
  LOG_TYPES.CLIENT,
  true,
  true
);
Logger.prototype.logToBuffer = makeLoggerMethod('info', 'info', LOG_TYPES.SDK, true, true);

export default Logger;
