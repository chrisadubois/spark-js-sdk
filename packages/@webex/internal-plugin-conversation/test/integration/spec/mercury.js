/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import '@webex/internal-plugin-conversation';

import WebexCore from '@webex/webex-core';
import {assert} from '@webex/test-helper-chai';
import testUsers from '@webex/test-helper-test-users';
import uuid from 'uuid';

describe('plugin-conversation', function () {
  this.timeout(30000);
  describe('mercury processing', () => {
    let kirk, mccoy, participants, webex;

    before(() => testUsers.create({count: 3})
      .then((users) => {
        [kirk, mccoy] = participants = users;

        webex = new WebexCore({
          credentials: {
            authorization: mccoy.token
          }
        });

        kirk.webex = new WebexCore({
          credentials: {
            authorization: kirk.token
          }
        });

        return Promise.all([
          webex.internal.mercury.connect(),
          kirk.webex.internal.mercury.connect()
        ]);
      }));

    after(() => Promise.all([
      webex && webex.internal.mercury.disconnect(),
      kirk && kirk.webex.internal.mercury.disconnect()
    ]));

    let conversation;

    beforeEach(() => {
      if (conversation) {
        return Promise.resolve();
      }

      return webex.internal.conversation.create({participants})
        .then((c) => { conversation = c; });
    });

    describe('when an activity is received', () => {
      it('is decrypted and normalized', () => {
        const clientTempId = uuid.v4();
        const promise = new Promise((resolve) => {
          kirk.webex.internal.mercury.on('event:conversation.activity', (event) => {
            if (event.data.activity.clientTempId === clientTempId) {
              resolve(event);
            }
          });
        });

        const message = 'Dammit Jim, I\'m a Doctor not a brick-layer!';

        webex.internal.conversation.post(conversation, {
          displayName: message
        }, {
          clientTempId
        });

        return promise
          .then((event) => {
            assert.isActivity(event.data.activity);
            assert.isEncryptedActivity(event.data.activity);
            assert.equal(event.data.activity.encryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);
            assert.equal(event.data.activity.object.displayName, message);
          });
      });
    });
  });
});
