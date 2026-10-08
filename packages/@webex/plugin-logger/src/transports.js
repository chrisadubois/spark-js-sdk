/*!
 * Copyright (c) 2015-2026 Cisco Systems, Inc. See LICENSE file.
 */
/**
 * A transient, transport-facing view of one buffered entry. It is built only when a
 * transport flush selects the entry and is never retained by the logger.
 * @typedef {Object} LogTransportRecord
 * @property {number} seq logger-wide append sequence; with the session id it identifies the entry
 * @property {number} timestamp epoch milliseconds parsed from the entry's ISO time
 * @property {string} level the logger method level
 * @property {string} source 'sdk' or 'client'
 * @property {string} body the entry exactly as formatLogs() writes it
 * @property {string} [eventName]
 * @property {Object<string, string|number|boolean>} [attributes]
 */

/**
 * @typedef {Object} LogTransport
 * @property {string} name
 * @property {function(Array<LogTransportRecord>): Promise<void>} export
 */

/**
 * @typedef {Object} FlushTransportResult
 * @property {number} exported records acknowledged by this flush
 * @property {number} remaining retained records still pending for the transport
 * @property {number} dropped records evicted before the transport read them
 */

const RECORD_OVERHEAD_BYTES = 64;

const transportStates = new WeakMap();

/**
 * Per-logger transport state, kept outside Ampersand props so the append path
 * stays a plain property write.
 * @param {Object} logger
 * @private
 * @returns {{sequence: number, transports: Map}}
 */
export function getTransportState(logger) {
  let state = transportStates.get(logger);

  if (!state) {
    state = {sequence: 0, transports: new Map()};
    transportStates.set(logger, state);
  }

  return state;
}

/**
 * O(1) size estimate in UTF-16 code units; the transport checks the exact encoded size.
 * @param {LogTransportRecord} record
 * @private
 * @returns {number} estimated serialized size
 */
function estimateRecordBytes(record) {
  let bytes = RECORD_OVERHEAD_BYTES + record.body.length;

  if (record.eventName) {
    bytes += record.eventName.length;
  }
  if (record.attributes) {
    Object.keys(record.attributes).forEach((key) => {
      const value = record.attributes[key];

      bytes += key.length + (typeof value === 'string' ? value.length : 8);
    });
  }

  return bytes;
}

/**
 * @param {Array} entry a buffered entry
 * @private
 * @returns {LogTransportRecord}
 */
function buildTransportRecord(entry) {
  const record = {
    seq: entry.seq,
    timestamp: Date.parse(entry[1]),
    level: entry.level,
    source: entry.source,
    body: String(entry),
  };

  if (entry.meta && entry.meta.eventName) {
    record.eventName = entry.meta.eventName;
  }
  if (entry.meta && entry.meta.attributes) {
    record.attributes = entry.meta.attributes;
  }

  return record;
}

/**
 * @param {Object} logger
 * @private
 * @returns {Array<{key: string, ref: Object}>} the retained histories transports read
 */
function getHistories(logger) {
  if (logger.config.separateLogBuffers) {
    return [
      {key: 'sdk', ref: logger.sdkBuffer},
      {key: 'client', ref: logger.clientBuffer},
    ];
  }

  return [{key: 'single', ref: logger.buffer}];
}

/**
 * @param {Array<{key: string, ref: Object}>} histories
 * @param {Object<string, number>} cursors absolute positions
 * @private
 * @returns {number} retained entries the transport has not exported
 */
function countPending(histories, cursors) {
  return histories.reduce((total, {key, ref}) => {
    const evictedCount = ref.evictedCount || 0;
    const start = Math.max(cursors[key] || 0, evictedCount);

    return total + Math.max(0, evictedCount + ref.buffer.length - start);
  }, 0);
}

/**
 * Selects the next entries in append order across the histories, exports them, and
 * advances the cursors only when the export resolves.
 *
 * `remaining` counts only entries that were pending at selection and left out by the
 * budget; entries appended while the export ran are new work, not backlog. `dropped`
 * counts entries evicted before the transport read them, carried over failed exports.
 * @param {Object} logger
 * @param {Object} registration
 * @param {Object} options
 * @private
 * @returns {Promise<FlushTransportResult>}
 */
export async function exportNextBatch(
  logger,
  registration,
  {maxBytes = Infinity, maxRecords = 1000} = {}
) {
  const histories = getHistories(logger);
  const {cursors} = registration;

  const positions = histories.map(({key, ref}) => {
    const evictedCount = ref.evictedCount || 0;
    const cursor = cursors[key] === undefined ? evictedCount : cursors[key];

    if (cursor < evictedCount) {
      registration.dropped = (registration.dropped || 0) + evictedCount - cursor;
    }
    cursors[key] = Math.max(cursor, evictedCount);

    return {key, ref, evictedCount, index: cursors[key] - evictedCount};
  });
  const pending = countPending(histories, cursors);

  const records = [];
  let bytes = 0;

  while (records.length < maxRecords) {
    let next;

    positions.forEach((position) => {
      const entry = position.ref.buffer[position.index];

      if (entry && (!next || entry.seq < next.entry.seq)) {
        next = {position, entry};
      }
    });

    if (!next) {
      break;
    }

    const record = buildTransportRecord(next.entry);
    const size = estimateRecordBytes(record);

    if (records.length > 0 && bytes + size > maxBytes) {
      break;
    }

    records.push(record);
    bytes += size;
    next.position.index += 1;
  }

  if (records.length > 0) {
    await registration.transport.export(records);

    // absolute positions captured at selection stay correct if eviction ran during the export
    positions.forEach(({key, evictedCount, index}) => {
      cursors[key] = Math.max(cursors[key], evictedCount + index);
    });
  }

  const dropped = registration.dropped || 0;

  registration.dropped = 0;

  return {exported: records.length, remaining: pending - records.length, dropped};
}
