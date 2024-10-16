/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

/* eslint max-nested-callbacks: [0] */
/* eslint no-console: [0] */
/* eslint-disable no-invalid-this */

const wd = require('wd');

wd.addPromiseChainMethod('printLogs', function printLogs() {
  return this
    .log('browser')
    .then((logs) => {
      logs.forEach((log) => {
        try {
          log.message = JSON.parse(log.message);
          const method = console[log.message.message.level] || console.log;

          console[method]('broser log:', log.message.message.text);
        }
        catch (err) {
          console.log('browser log:', log.message);
        }
      });
    })
    .catch((reason) => {
      console.warn('failed to fetch browser logs', reason);
    });
});
