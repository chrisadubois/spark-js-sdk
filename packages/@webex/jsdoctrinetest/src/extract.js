/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */


import fs from 'fs';

import traverse from '@babel/traverse';
import doctrine from 'doctrine';
import {isProgram} from '@babel/types';

import parse from './parse';
/**
 * transform function which operates on each discovered example block
 * @callback transformCallback
 * @param {Object} options
 * @param {ast} options.comment
 * @param {string} options.name
 * @param {string} options.filename
 * @param {string} options.type
 */

/**
 * Extracts comment blocks from the source code in the specified file
 * @param {transformCallback} transform
 * @param {string} filename
 * @returns {Array<ast>}
 */
export default function extract(transform, filename) {
  // eslint-disable-next-line no-sync
  const code = fs.readFileSync(filename, {encoding: 'utf8'});

  const ast = parse(code, {sourceFilename: filename});

  const results = [];

  let done = false;

  traverse(ast, {
    enter(path) {
      if (path.node.leadingComments) {
        path.node.leadingComments
          .filter(isJSDocComment)
          .forEach((comment) => {
            const result = doctrine.parse(comment.value, {
              unwrap: true,
              sloppy: true,
              recoverable: true,
              lineNumbers: true
            });

            if (result.tags) {
              result.tags.forEach((tag) => {
                if (tag.title === 'example') {
                  results.push(transform({
                    comment: tag.description,
                    name: getNodeName(path.node),
                    filename: path.node.loc.filename,
                    type: path.node.type
                  }));
                }
              });
            }
          });
      }
    },
    Program: {
      exit(path) {
        if (isProgram(path)) {
          if (done) {
            return;
          }
          path.pushContainer('body', results);
          done = true;
        }
      }
    }
  });

  return ast;
}

/**
 * Extracts the name from the specified node
 * @param {Node} node
 * @returns {string}
 */
function getNodeName(node) {
  if (node.id) {
    return node.id.name;
  }

  if (node.key) {
    return node.key.name;
  }

  throw new Error('Could not find name for node');
}
/**
 * Indicates if the specified comment block is a doc block
 * @param {CommentBlock} comment
 * @returns {Boolean}
 */
function isJSDocComment(comment) {
  const asterisks = comment.value.match(/^(\*+)/);

  if (comment.value.startsWith('/*') && comment.value.endsWith('*/')) {
    return false;
  }

  // eslint-disable-next-line
  return (comment.type === `CommentBlock` || // estree
    // eslint-disable-next-line
    comment.type === `Block`) // get-comments / traditional
    // eslint-disable-next-line
    && asterisks && asterisks[ 1 ].length === 1;
}
