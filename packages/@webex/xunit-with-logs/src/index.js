/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

// These'll get cleaned up in the xunit PR; for now, they're just here because
// this file attempted to follow the format of the mocha core xunit reporter
/* eslint-disable no-console */
/* eslint-disable no-multi-assign */

/**
 * Module dependencies.
 */

const util = require('util');
const fs = require('fs');

const Base = require('mocha/lib/reporters/base');
const utils = require('mocha/lib/utils');

const {escape} = utils;
const mkdirp = require('mkdirp');

const path = require('path');

const {pick} = require('lodash');

/**
 * Expose `XUnit`.
 */

exports = module.exports = XUnit;

/**
 * Initialize a new `XUnit` reporter.
 *
 * @param {Runner} runner
 * @param {Object} options
 * @returns {undefined}
 * @api public
 */
function XUnit(runner, options) {
  Reflect.apply(Base, this, [runner]);
  const {stats} = this;
  const tests = [];
  const self = this;

  if (options.reporterOptions && options.reporterOptions.output) {
    if (!fs.createWriteStream) {
      throw new Error('file output not supported in browser');
    }
    mkdirp.sync(path.dirname(options.reporterOptions.output));
    self.fileStream = fs.createWriteStream(options.reporterOptions.output);
  }

  runner.on('pending', (test) => {
    tests.push(test);
  });

  runner.on('pass', (test) => {
    tests.push(test);
  });

  runner.on('fail', (test) => {
    tests.push(test);
  });

  const logMethodNames = ['error', 'warn', 'log', 'info', 'debug', 'trace'];
  const originalMethods = pick(console, logMethodNames);

  runner.on('test', (test) => {
    test.systemErr = [];
    test.systemOut = [];

    logMethodNames.forEach((methodName) => {
      if (!console[methodName]) {
        methodName = 'log';
      }

      console[methodName] = (...args) => {
        Reflect.apply(originalMethods[methodName], console, args);

        const callerInfo = (new Error())
          .stack
          .split('\n')[2]
          .match(/\((.+?):(\d+):\d+/);

        if (callerInfo && callerInfo.length >= 2) {
          const callerFile = path.relative(__dirname, '..', callerInfo[1]);

          args.unshift(`(FILE:${callerFile || 'UNKNOWN'})`);
          args.unshift(`(LINE:${callerInfo[2] || 'UNKNOWN'})`);
        }

        if (methodName === 'error') {
          test.systemErr.push(args);
        }
        else {
          args.unshift(`${methodName.toUpperCase()}:`);

          test.systemOut.push(args);
        }
      };
    });
  });

  runner.on('test end', () => {
    logMethodNames.forEach((methodName) => {
      console[methodName] = originalMethods[methodName];
    });
  });

  runner.on('end', () => {
    self.write('<testsuites>');
    self.write(tag('testsuite', {
      name: 'Mocha Tests',
      tests: stats.tests,
      failures: stats.failures,
      errors: stats.failures,
      skipped: stats.tests - stats.failures - stats.passes,
      timestamp: (new Date()).toUTCString(),
      time: stats.duration / 1000 || 0
    }, false));

    tests.forEach((t) => {
      self.test(t);
    });

    self.write('</testsuite>');
    self.write('</testsuites>');
  });
}

/**
 * Inherit from `Base.prototype`.
 */
util.inherits(XUnit, Base);

/**
 * Override done to close the stream (if it's a file).
 *
 * @param {Array} failures
 * @param {Function} fn
 * @returns {undefined}
 */
XUnit.prototype.done = function done(failures, fn) {
  if (this.fileStream) {
    this.fileStream.end(() => {
      fn(failures);
    });
  }
  else {
    fn(failures);
  }
};

/**
 * Write out the given line.
 *
 * @param {string} line
 * @returns {undefined}
 */
XUnit.prototype.write = function write(line) {
  if (this.fileStream) {
    this.fileStream.write(`${line}\n`);
  }
  else {
    console.log(line);
  }
};

/**
 * Output tag for the given `test.`
 *
 * @param {Test} test
 * @returns {undefined}
 */
XUnit.prototype.test = function testFn(test) {
  const attrs = {
    classname: test.parent.fullTitle(),
    name: test.title,
    time: test.duration / 1000 || 0
  };

  let systemErr;

  if (test.systemErr && test.systemErr.length > 0) {
    systemErr = tag('system-err', {}, false, cdata(test.systemErr.reduce(reducer, '\n')));
  }
  else {
    systemErr = '';
  }

  let systemOut;

  if (test.systemOut && test.systemOut.length > 0) {
    systemOut = tag('system-out', {}, false, cdata(test.systemOut.reduce(reducer, '\n')));
  }
  else {
    systemOut = '';
  }

  if (test.state === 'failed') {
    const {err} = test;
    const failureMessage = tag('failure', {}, false, cdata(`${escape(err.message)}\n${err.stack}`));

    this.write(tag('testcase', attrs, false, failureMessage + systemOut + systemErr));
  }
  else if (test.pending) {
    this.write(tag('testcase', attrs, false, tag('skipped', {}, true)));
  }
  else {
    this.write(tag('testcase', attrs, true));
  }

  /**
   * reducer
   * @param {string} out
   * @param {Array<mixed>} args
   * @returns {string}
   * @private
   */
  function reducer(out, args) {
    return `${out + args.reduce((innerOut, arg) => `${innerOut + arg} `, '')}\n`;
  }
};

/**
 * HTML tag helper.
 *
 * @param {string} name
 * @param {Object} attrs
 * @param {boolean} close
 * @param {string} content
 * @returns {string}
 */
function tag(name, attrs, close, content) {
  const end = close ? '/>' : '>';
  const pairs = [];
  let innerTag;

  for (const [key, value] of Object.entries(attrs)) {
    pairs.push(`${key}="${escape(value)}"`);
  }

  innerTag = `<${name}${pairs.length ? ` ${pairs.join(' ')}` : ''}${end}`;
  if (content) {
    innerTag += `${content}</${name}${end}`;
  }

  return innerTag;
}

/**
 * Return cdata escaped CDATA `str`.
 * @param {string} str
 * @returns {string}
 */
function cdata(str) {
  return `<![CDATA[${escape(str)}]]>`;
}
