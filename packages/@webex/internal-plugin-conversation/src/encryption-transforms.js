/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import {
  capitalize,
  curry,
  get,
  has,
  isArray
} from 'lodash';

import toArray from './to-array';

const KEY = Symbol('KEY');

const encryptTextProp = curry((name, ctx, key, object) => ctx.transform('encryptTextProp', name, key, object));

const encryptJsonProp = curry((name, ctx, key, object) => ctx.transform('encryptJsonProp', name, key, object));

// eslint-disable-next-line import/prefer-default-export
export const transforms = toArray('outbound', {
  encryptObject(ctx, key, object) {
    if (!object) {
      object = key;
      key = undefined;
    }

    if (!object) {
      return Promise.resolve();
    }

    if (!object.objectType) {
      return Promise.resolve();
    }

    if (key === false) {
      return Promise.resolve();
    }

    return ctx.transform(`encrypt${capitalize(object.objectType)}`, key, object);
  },

  encryptReaction2(ctx, key, reaction2) {
    return ctx.transform('encryptPropDisplayName', key, reaction2);
  },

  encryptConversation(ctx, key, conversation) {
    if (key === false) {
      return Promise.resolve();
    }

    return Promise.resolve(key || ctx.webex.internal.encryption.kms.createUnboundKeys({count: 1}))
      .then((keys) => {
        const k = isArray(keys) ? keys[0] : keys;

        if (has(conversation, 'kmsMessage.keyUris') && !conversation.kmsMessage.keyUris.includes(k.uri)) {
          conversation.kmsMessage.keyUris.push(k.uri);
        }

        return Promise.all([
          // too many implicit returns on the same line is difficult to interpret
          // eslint-disable-next-line arrow-body-style
          has(conversation, 'activities.items') && conversation.activities.items.reduce((p, activity) => {
            // eslint-disable-next-line max-nested-callbacks
            return p.then(() => ctx.transform('encryptObject', k, activity));
          }, Promise.resolve()),
          ctx.transform('encryptPropDisplayName', k, conversation)
        ])
          .then(() => {
            conversation.encryptionKeyUrl = k.uri || k;
            // we only want to set the defaultActivityEncryptionKeyUrl if we've
            // bound a new key
            if (!key) {
              conversation.defaultActivityEncryptionKeyUrl = conversation.defaultActivityEncryptionKeyUrl || k.uri || k;
            }
          });
      });
  },

  encryptActivity(ctx, key, activity) {
    // Activity is already encrypted
    if (activity.encryptionKeyUrl || activity.object?.created === 'True') {
      return Promise.resolve();
    }

    return ctx.transform(`encrypt${capitalize(activity.verb)}Activity`, key, activity)
      .then(() => {
        key = key || activity[KEY];

        return ctx.transform('prepareActivityKmsMessage', key, activity);
      });
  },

  encryptVerbActivity(ctx, key, activity) {
    return ctx.transform('maybeEncryptTarget', key, activity)
      .then(() => {
        key = key || activity[KEY];
      })
      .then(() => ctx.transform('encryptObject', key, activity.object));
  },

  maybeEncryptTarget(ctx, key, activity) {
    // This isn't quite right; if we just go by key, we have no guarantee that
    // we have a proper KRO available for add activities
    if (key) {
      return Promise.resolve();
    }

    if (has(activity, 'target.defaultActivityEncryptionKeyUrl') &&
      activity.target.defaultActivityEncryptionKeyUrl &&
      has(activity, 'target.kmsResourceObjectUrl')
    ) {
      activity[KEY] = key || activity.target.defaultActivityEncryptionKeyUrl;

      return Promise.resolve();
    }

    const conversationUrl = activity.target && activity.target.url;

    if (!conversationUrl) {
      return Promise.reject(new Error('Cannot determine encryption key for activity\'s conversation; no key url or conversation url provided'));
    }

    return ctx.webex.internal.conversation.get({url: conversationUrl})
      .then((conversation) => {
        if (!conversation.defaultActivityEncryptionKeyUrl) {
          return ctx.webex.internal.conversation.updateKey(conversation)
            .then((updateKeyActivity) => {
              if (updateKeyActivity.kmsMessage.resource) {
                activity.target.kmsResourceObjectUrl = updateKeyActivity.kmsMessage.resource.uri;
              }
              activity[KEY] = activity.target.defaultActivityEncryptionKeyUrl = updateKeyActivity.object.defaultActivityEncryptionKeyUrl;
            });
        }

        if (!activity.target.defaultActivityEncryptionKeyUrl) {
          ctx.webex.logger.warn('plugin-conversation: downloaded conversation to determine its defaultActivityEncryptionKeyUrl; make sure to pass all encryption related properties when calling Webex.conversation methods.');
        }

        if (!activity.target.kmsResourceObjectUrl) {
          ctx.webex.logger.warn('plugin-conversation: downloaded conversation to determine its kmsResourceObjectUrl; make sure to pass all encryption related properties when calling Webex.conversation methods.');
        }

        activity[KEY] = activity.target.defaultActivityEncryptionKeyUrl = conversation.defaultActivityEncryptionKeyUrl;
        activity.target.kmsResourceObjectUrl = conversation.kmsResourceObjectUrl;

        return Promise.resolve();
      });
  },

  prepareActivityKmsMessage(ctx, key, activity) {
    if (activity.kmsMessage) {
      if (!key && activity.verb === 'delete') {
        key = get(activity, 'target.defaultActivityEncryptionKeyUrl');
      }

      if (!key && activity.verb === 'updateKey' && has(activity, 'object.defaultActivityEncryptionKeyUrl')) {
        key = get(activity, 'object.defaultActivityEncryptionKeyUrl');
      }

      if (!key && activity.verb === 'leave' && has(activity, 'target.defaultActivityEncryptionKeyUrl')) {
        key = get(activity, 'target.defaultActivityEncryptionKeyUrl');
      }

      if (key) {
        const kro = activity.target.kmsResourceObjectUrl;

        ['uri', 'resourceUri'].forEach((k) => {
          if (activity.kmsMessage[k] && !kro && activity.kmsMessage[k].includes('<KRO>')) {
            throw new Error('encrypter: cannot determine kro');
          }

          if (activity.kmsMessage[k]) {
            activity.kmsMessage[k] = activity.kmsMessage[k].replace('<KRO>', kro);
            // key may be a key or a key url
            activity.kmsMessage[k] = activity.kmsMessage[k].replace('<KEYURL>', key.keyUrl || key);
          }
        });
      }
      // If we made it this far and still don't have an encryption key, assume
      // this is a conversation that is not encrypted and we're performing an
      // action that should not encrypt it (e.g. `leave`)
      else {
        Reflect.deleteProperty(activity, 'kmsMessage');
      }
    }
  },

  encryptVerbActivityWithKey: {
    direction: 'outbound',
    fn(ctx, key, activity) {
      return ctx.transform('encryptVerbActivity', key, activity)
        .then(() => {
          key = key || activity[KEY];
          activity.encryptionKeyUrl = key.uri || key;
        });
    }
  },

  encryptAddActivity: {
    direction: 'outbound',
    fn(ctx, key, activity) {
      if (has(activity, 'object.objectType') && activity.object.objectType === 'reaction2') {
        return ctx.transform('encryptVerbActivityWithKey', key, activity);
      }

      return ctx.transform('encryptVerbActivity', key, activity);
    }
  },

  encryptAssignActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivityWithKey'
  },

  encryptCreateActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivity'
  },

  encryptPostActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivityWithKey'
  },

  encryptShareActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivityWithKey'
  },

  encryptCardactionActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivityWithKey'
  },

  encryptUpdateActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivityWithKey'
  },

  encryptUpdateKeyActivity: {
    direction: 'outbound',
    alias: 'encryptVerbActivity'
  },

  encryptComment(ctx, key, comment) {
    return Promise.all([
      ctx.transform('encryptPropDisplayName', key, comment),
      ctx.transform('encryptPropContent', key, comment)
    ]);
  },

  encryptContent(ctx, key, content) {
    const promises = content.files.items.map((item) => ctx.transform('encryptObject', key, item));

    promises.push(ctx.transform('encryptPropContent', key, content));
    promises.push(ctx.transform('encryptPropDisplayName', key, content));

    return Promise.all(promises);
  },

  encryptFile(ctx, key, file) {
    if (file.image && !file.image.scr) {
      return Promise.reject(new Error('`file.image` must have an `scr`'));
    }

    return Promise.all([
      ctx.transform('encryptPropScr', key, file),
      ctx.transform('encryptPropDisplayName', key, file),
      ctx.transform('encryptPropContent', key, file),
      file.image && ctx.transform('encryptPropScr', key, file.image)
    ]);
  },

  encryptSubmit(ctx, key, submit) {
    return ctx.transform('encryptPropInputs', key, submit);
  },

  // TODO is this used for anything other than the now-removed stickies service?
  encryptImageURI(ctx, key, imageURI) {
    return ctx.transform('encryptPropLocation', key, imageURI);
  },

  encryptPropContent: encryptTextProp('content'),

  encryptPropDisplayName: encryptTextProp('displayName'),

  encryptPropInputs: encryptJsonProp('inputs'),

  encryptPropLocation: encryptTextProp('location'),

  encryptPropScr(ctx, key, object) {
    if (!object.scr) {
      return Promise.resolve();
    }

    return ctx.webex.internal.encryption.encryptScr(key, object.scr)
      .then((scr) => {
        object.scr = scr;
      });
  },

  encryptJsonProp(ctx, name, key, object) {
    if (!object[name]) {
      return Promise.resolve();
    }

    return ctx.webex.internal.encryption.encryptText(key.uri || key, JSON.stringify(object[name]))
      .then((ciphertext) => {
        object[name] = ciphertext;
      });
  },

  encryptTextProp(ctx, name, key, object) {
    if (!object[name]) {
      return Promise.resolve();
    }

    return ctx.webex.internal.encryption.encryptText(key.uri || key, object[name])
      .then((ciphertext) => {
        object[name] = ciphertext;
      });
  }
});
