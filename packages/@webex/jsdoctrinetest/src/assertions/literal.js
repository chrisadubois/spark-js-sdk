/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import template from '@babel/template';
import {
  booleanLiteral,
  numericLiteral,
  stringLiteral
} from '@babel/types';

const pattern = /^\s*?=>( async)?\s*/;

const tpl = template(`
  (function() {
    var assert = require('assert');
    assert.equal(result, ASSERTION);
  })();
`);

/**
 * Indicates whether the specified value defines a literal assertion
 * @param {string} value
 * @returns {Boolean}
 */
export function test(value) {
  return pattern.test(value);
}

/**
 * Builds a literal assertion
 * @param {string} value
 * @returns {ast}
 */
export function build(value) {
  return tpl({
    ASSERTION: literal(value.replace(pattern, ''))
  });
}

/**
 * Coerces a string into a type
 * @param {string} l
 * @returns {Literal}
 */
function literal(l) {
  /* eslint complexity: [0] */
  // eslint-disable-next-line prefer-const
  let f, i;

  switch (typeof l) {
    case 'boolean':
      return booleanLiteral(l);
    case 'number':
      return numericLiteral(l);
    case 'string':
      if (l === 'true') {
        return booleanLiteral(true);
      }
      if (l === 'false') {
        return booleanLiteral(false);
      }
      i = parseInt(l, 10);
      if (!Number.isNaN(i)) {
        return numericLiteral(i);
      }
      f = parseFloat(l);
      if (!Number.isNaN(f)) {
        return numericLiteral(f);
      }

      return stringLiteral(l);
    default:
      throw new Error('Unsupported literal type');
  }
}
