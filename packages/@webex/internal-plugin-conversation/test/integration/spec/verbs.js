/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import '@webex/internal-plugin-conversation';

import {patterns} from '@webex/common';
import WebexCore, {WebexHttpError} from '@webex/webex-core';
import {assert} from '@webex/test-helper-chai';
import testUsers from '@webex/test-helper-test-users';
import {find, map} from 'lodash';
import uuid from 'uuid';
import fh from '@webex/test-helper-file';
import {skipInNode} from '@webex/test-helper-mocha';


describe('plugin-conversation', function () {
  this.timeout(30000);
  describe('verbs', () => {
    let checkov, mccoy, participants, webex, spock;

    before(() => testUsers.create({count: 3})
      .then(async (users) => {
        [spock, mccoy, checkov] = participants = users;

        // Pause for 5 seconds for CI
        await new Promise((done) => setTimeout(done, 5000));

        webex = new WebexCore({
          credentials: {
            authorization: spock.token
          }
        });

        mccoy.webex = new WebexCore({
          credentials: {
            authorization: mccoy.token
          }
        });

        return Promise.all([
          webex.internal.mercury.connect(),
          mccoy.webex.internal.mercury.connect()
        ]);
      }));

    after(() => Promise.all([
      webex && webex.internal.mercury.disconnect(),
      mccoy && mccoy.webex.internal.mercury.disconnect()
    ]));

    function makeEmailAddress() {
      return `webex-js-sdk--test-${uuid.v4()}@example.com`;
    }

    let conversation;

    beforeEach(() => {
      if (conversation) {
        return Promise.resolve();
      }

      return webex.internal.conversation.create({participants})
        .then((c) => { conversation = c; });
    });

    describe('#add()', () => {
      let email;

      beforeEach(() => { email = makeEmailAddress(); });

      beforeEach(() => webex.internal.conversation.create({participants: [checkov]}, {forceGrouped: true})
        .then((c) => { conversation = c; }));

      it('adds the specified user to the specified conversation', () => webex.internal.conversation.add(conversation, mccoy)
        .then((activity) => {
          assert.isActivity(activity);
          assert.property(activity, 'kmsMessage');
        }));

      it('grants the specified user access to the conversation\'s key', () => webex.internal.conversation.post(conversation, {displayName: 'PROOF!'})
        .then(() => webex.internal.conversation.add(conversation, mccoy))
        .then(() => mccoy.webex.internal.conversation.get(conversation, {activitiesLimit: 10}))
        .then((c) => {
          assert.isConversation(c);
          const activity = find(c.activities.items, {verb: 'post'});

          assert.equal(activity.object.displayName, 'PROOF!');
        }));

      // TODO: Issues with side boarding users too soon. Skipping until it's fixed
      it.skip('sideboards a non-existent user', () => webex.internal.conversation.add(conversation, email)
        .then((activity) => {
          assert.isActivity(activity);

          return webex.internal.conversation.get(conversation, {includeParticipants: true});
        })
        .then((c) => {
          assert.isConversation(c);
          const participant = find(c.participants.items, {emailAddress: email});

          assert.include(participant.tags, 'SIDE_BOARDED');
          assert.match(participant.id, patterns.uuid);
        }));
    });

    describe('#assign()', () => {
      before(() => webex.internal.conversation.create({participants})
        .then((c) => {
          conversation = c;
        }));

      let sampleImageSmallOnePng = 'sample-image-small-one.png';

      before(() => fh.fetch(sampleImageSmallOnePng)
        .then((res) => {
          sampleImageSmallOnePng = res;
        }));

      it('assigns an avatar to a room', () => webex.internal.conversation.assign(conversation, sampleImageSmallOnePng)
        .then(() => webex.internal.conversation.get(conversation))
        .then((c) => {
          assert.property(c, 'avatar');

          assert.property(c.avatar, 'files');
          assert.property(c.avatar.files, 'items');
          assert.lengthOf(c.avatar.files.items, 1);
          assert.property(c.avatar.files.items[0], 'fileSize');
          assert.property(c.avatar.files.items[0], 'mimeType');
          assert.property(c.avatar.files.items[0], 'objectType');
          assert.property(c.avatar.files.items[0], 'scr');
          assert.property(c.avatar.files.items[0], 'url');
          assert.equal(c.avatar.objectType, 'content');

          assert.isString(c.avatarEncryptionKeyUrl);
          assert.isObject(c.avatar.files.items[0].scr, 'The scr was decrypted');
          assert.equal(c.avatar.files.items[0].displayName, 'sample-image-small-one.png');

          assert.property(c, 'avatarEncryptionKeyUrl');
        }));
    });

    describe('#leave()', () => {
      afterEach(() => { conversation = null; });

      it('removes the current user from the specified conversation', () => webex.internal.conversation.leave(conversation)
        .then((activity) => {
          assert.isActivity(activity);

          return assert.isRejected(webex.internal.conversation.get(conversation));
        })
        .then((reason) => {
          assert.statusCode(reason, 404);

          return assert.isRejected(webex.internal.encryption.kms.fetchKey({uri: conversation.defaultActivityEncryptionKeyUrl}));
        })
        .then((reason) => assert.equal(reason.status, 403)));

      it('removes the specified user from the specified conversation', () => webex.internal.conversation.leave(conversation, mccoy)
        .then((activity) => {
          assert.isActivity(activity);

          return assert.isRejected(mccoy.webex.internal.conversation.get(conversation));
        })
        .then((reason) => {
          assert.statusCode(reason, 404);

          return assert.isRejected(mccoy.webex.internal.encryption.kms.fetchKey({uri: conversation.defaultActivityEncryptionKeyUrl}));
        })
        .then((reason) => assert.equal(reason.status, 403)));

      describe('with deleted users', () => {
        let redshirt;

        beforeEach(() => testUsers.create({count: 1})
          .then(([rs]) => {
            redshirt = rs;

            return webex.internal.conversation.add(conversation, rs);
          }));

        it('removes the specified deleted user from the specified conversation', () => webex.internal.conversation.leave(conversation, redshirt)
          .then(() => webex.internal.conversation.get(conversation, {includeParticipants: true}))
          .then((c) => {
            assert.lengthOf(c.participants.items, 3);
            assert.notInclude(map(c.participants.items, 'id'), redshirt.id);
          }));
      });
    });

    describe('#leave() with id only', () => {
      afterEach(() => { conversation = null; });

      it('removes the current user by id only', () => webex.internal.conversation.leave({
        id: conversation.id,
        defaultActivityEncryptionKeyUrl: conversation.defaultActivityEncryptionKeyUrl,
        kmsResourceObjectUrl: conversation.kmsResourceObjectUrl
      })
        .then((activity) => {
          assert.isActivity(activity);

          return assert.isRejected(webex.internal.conversation.get(conversation));
        })
        .then((reason) => {
          assert.statusCode(reason, 404);

          return assert.isRejected(webex.internal.encryption.kms.fetchKey({uri: conversation.defaultActivityEncryptionKeyUrl}));
        })
        .then((reason) => assert.equal(reason.status, 403)));
    });


    describe('#post()', () => {
      let message, richMessage;

      beforeEach(() => {
        message = 'mccoy, THIS IS A TEST MESSAGE';
        richMessage = `<webex-mention data-object-id="${mccoy.id}" data-object-type="person">mccoy</webex-mention>, THIS IS A TEST MESSAGE`;
      });

      // disable until helper-html has node support
      skipInNode(describe)('when there are html tags in rich messages', () => {
        const allTagsUsedInThisTest = {
          div: [],
          b: [],
          span: []
        };

        [
          {
            it: 'allows allowed outbound and inbound tags',
            allowedOutboundTags: {div: []},
            allowedInboundTags: {div: []},
            outboundMessage: '<div>HELLO</div>',
            outboundFilteredMessage: '<div>HELLO</div>',
            inboundMessage: '<div>HELLO</div>'
          },
          {
            it: 'filters and escapes disallowed outbound tags',
            allowedOutboundTags: {},
            allowedInboundTags: {},
            outboundMessage: '<div><b>HELLO</b></div>',
            outboundFilteredMessage: '&lt;div&gt;&lt;b&gt;HELLO&lt;/b&gt;&lt;/div&gt;',
            inboundMessage: '&lt;div&gt;&lt;b&gt;HELLO&lt;/b&gt;&lt;/div&gt;'
          },
          {
            it: 'filters disallowed inbound tags',
            allowedOutboundTags: {div: [], b: []},
            allowedInboundTags: {b: []},
            outboundMessage: '<div><b>HELLO</b></div>',
            outboundFilteredMessage: '<div><b>HELLO</b></div>',
            inboundMessage: '<b>HELLO</b>'
          },
          {
            it: 'filters and escapes the correct outbound tags',
            allowedOutboundTags: {div: [], span: []},
            allowedInboundTags: {},
            outboundMessage: '<div><b>HELLO</b><span> it\'s me</span></div>',
            outboundFilteredMessage: '<div>&lt;b&gt;HELLO&lt;/b&gt;<span> it\'s me</span></div>',
            inboundMessage: '&lt;b&gt;HELLO&lt;/b&gt; it\'s me'
          },
          {
            it: 'filters the correct inbound tags and filters and escapes the correct outbound tags',
            allowedOutboundTags: {div: [], span: []},
            allowedInboundTags: {span: []},
            outboundMessage: '<div><b>HELLO</b><span> it\'s me</span></div>',
            outboundFilteredMessage: '<div>&lt;b&gt;HELLO&lt;/b&gt;<span> it\'s me</span></div>',
            inboundMessage: '&lt;b&gt;HELLO&lt;/b&gt;<span> it\'s me</span>'
          }
        ].forEach((def) => {
          it(def.it, () => {
            webex.config.conversation.allowedOutboundTags = def.allowedOutboundTags;
            // since responses to spock's post will count as 'inbound', we
            // enable all the tags for allowedInboundTags so that we know
            // the message is filtered by only the outbound rules
            webex.config.conversation.allowedInboundTags = allTagsUsedInThisTest;

            return webex.internal.conversation.post(conversation, {
              displayName: message,
              content: def.outboundMessage
            })
              .then((activity) => {
                assert.equal(activity.object.content, def.outboundFilteredMessage);
                mccoy.webex.config.conversation.allowedInboundTags = def.allowedInboundTags;

                return mccoy.webex.internal.conversation.get(conversation, {activitiesLimit: 1});
              })
              .then((convo) => {
                // check latest message
                const activity = find(convo.activities.items, {verb: 'post'});

                assert.equal(activity.object.content, def.inboundMessage);
              });
          });
        });
      });

      describe('when encryption key need to rotate', () => {
        it('can post a plain text successfully', () => {
          const {defaultActivityEncryptionKeyUrl} = conversation;

          Promise.all([webex.request({
            method: 'GET',
            api: 'conversation',
            resource: `/conversations/${conversation.id}/healed?resetKey=true`
          }).then(() =>
            webex.request({
              method: 'GET',
              api: 'conversation',
              resource: `conversations/${conversation.id}`
            }))])
            .then((res) => {
              res.body.defaultActivityEncryptionKeyUrl = defaultActivityEncryptionKeyUrl;

              return webex.internal.conversation.post(res.body, message);
            })
            .then((res) => {
              assert.notEqual(res.body.defaultActivityEncryptionKeyUrl, defaultActivityEncryptionKeyUrl);
            });
        });
      });

      it('posts a comment to the specified conversation', () => webex.internal.conversation.post(conversation, message)
        .then((activity) => {
          assert.isActivity(activity);

          assert.isEncryptedActivity(activity);
          assert.equal(activity.encryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);

          assert.equal(activity.object.displayName, message);
        }));

      it('updates the specified conversation\'s unread status', () => mccoy.webex.internal.conversation.get(conversation)
        .then((c) => {
          const {
            lastSeenActivityDate,
            lastReadableActivityDate
          } = c;

          return webex.internal.conversation.post(conversation, message)
            .then(() => mccoy.webex.internal.conversation.get(conversation)
              .then((c2) => {
                assert.equal(c2.lastSeenActivityDate, lastSeenActivityDate);
                assert.isAbove(Date.parse(c2.lastReadableActivityDate), Date.parse(lastReadableActivityDate));
              }));
        }));

      it('posts rich content to the specified conversation', () => webex.internal.conversation.post(conversation, {
        displayName: message,
        content: richMessage
      })
        .then((activity) => {
          assert.isActivity(activity);

          assert.isEncryptedActivity(activity);
          assert.equal(activity.encryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);

          assert.equal(activity.object.displayName, message);
          assert.equal(activity.object.content, richMessage);
        }));

      it('submits mentions to the specified conversation', () => webex.internal.conversation.post(conversation, {
        displayName: message,
        content: richMessage,
        mentions: {
          items: [{
            id: mccoy.id,
            objectType: 'person'
          }]
        }
      })
        .then((activity) => {
          assert.isActivity(activity);

          assert.isEncryptedActivity(activity);
          assert.equal(activity.encryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);

          assert.equal(activity.object.displayName, message);
          assert.equal(activity.object.content, richMessage);

          assert.isDefined(activity.object.mentions);
          assert.isDefined(activity.object.mentions.items);
          assert.lengthOf(activity.object.mentions.items, 1);
          assert.equal(activity.object.mentions.items[0].id, mccoy.id);
        }));
    });

    describe('#update()', () => {
      it('renames the specified conversation', () => webex.internal.conversation.update(conversation, {
        displayName: 'displayName2',
        objectType: 'conversation'
      })
        .then((c) => webex.internal.conversation.get({url: c.target.url}))
        .then((c) => assert.equal(c.displayName, 'displayName2')));
    });

    describe('#unassign()', () => {
      before(() => webex.internal.conversation.create({participants})
        .then((c) => {
          conversation = c;
        }));

      let sampleImageSmallOnePng = 'sample-image-small-one.png';

      before(() => fh.fetch(sampleImageSmallOnePng)
        .then((res) => {
          sampleImageSmallOnePng = res;
        }));

      beforeEach(() => webex.internal.conversation.assign(conversation, sampleImageSmallOnePng));

      it('unassigns an avatar from a room', () => webex.internal.conversation.unassign(conversation)
        .then(() => webex.internal.conversation.get(conversation)
          .then((c) => {
            assert.notProperty(c, 'avatar');
            assert.notProperty(c, 'avatarEncryptionKeyUrl');
          })));
    });

    describe('#updateKey()', () => {
      beforeEach(() => webex.internal.conversation.create({participants, comment: 'THIS IS A COMMENT'})
        .then((c) => { conversation = c; }));

      it('assigns an unused key to the specified conversation', () => webex.internal.conversation.updateKey(conversation)
        .then((activity) => {
          assert.isActivity(activity);

          return webex.internal.conversation.get(conversation);
        })
        .then((c) => {
          assert.isDefined(c.defaultActivityEncryptionKeyUrl);
          assert.notEqual(c.defaultActivityEncryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);
        }));

      it('assigns the specified key to the specified conversation', () => webex.internal.encryption.kms.createUnboundKeys({count: 1})
        .then(([key]) => webex.internal.conversation.updateKey(conversation, key)
          .then((activity) => {
            assert.isActivity(activity);
            assert.equal(activity.object.defaultActivityEncryptionKeyUrl, key.uri);

            return webex.internal.conversation.get(conversation);
          })
          .then((c) => {
            assert.isDefined(c.defaultActivityEncryptionKeyUrl);
            assert.notEqual(c.defaultActivityEncryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);
          })));

      it('grants access to the key for all users in the conversation', () => webex.internal.conversation.updateKey(conversation)
        .then((activity) => {
          assert.isActivity(activity);

          return mccoy.webex.internal.conversation.get({
            url: conversation.url,
            participantsLimit: 0,
            activitiesLimit: 0
          });
        })
        .then((c) => {
          assert.isDefined(c.defaultActivityEncryptionKeyUrl);
          assert.notEqual(c.defaultActivityEncryptionKeyUrl, conversation.defaultActivityEncryptionKeyUrl);

          return mccoy.webex.internal.encryption.kms.fetchKey({uri: c.defaultActivityEncryptionKeyUrl});
        }));
    });

    describe('#updateTypingStatus()', () => {
      beforeEach(() => webex.internal.conversation.create({participants, comment: 'THIS IS A COMMENT'})
        .then((c) => {
          conversation = c;
        }));

      it('sets the typing indicator for the specified conversation', () => webex.internal.conversation.updateTypingStatus(conversation, {typing: true})
        .then(({statusCode}) => {
          assert.equal(statusCode, 204);
        }));

      it('clears the typing indicator for the specified conversation', () => webex.internal.conversation.updateTypingStatus(conversation, {typing: false})
        .then(({statusCode}) => {
          assert.equal(statusCode, 204);
        }));

      it('fails if called with a bad conversation object', () => {
        let error;

        return webex.internal.conversation.updateTypingStatus({}, {typing: false})
          .catch((reason) => {
            error = reason;
          })
          .then(() => {
            assert.isDefined(error);
          });
      });

      it('infers id from conversation url if missing', () => {
        Reflect.deleteProperty(conversation, 'id');

        return webex.internal.conversation.updateTypingStatus(conversation, {typing: true})
          .then(({statusCode}) => {
            assert.equal(statusCode, 204);
          });
      });
    });

    describe('verbs that update conversation tags', () => {
      [
        {
          itString: 'favorites the specified conversation',
          tag: 'FAVORITE',
          verb: 'favorite'
        },
        {
          itString: 'hides the specified conversation',
          tag: 'HIDDEN',
          verb: 'hide'
        },
        {
          itString: 'locks the specified conversation',
          tag: 'LOCKED',
          verb: 'lock'
        },
        {
          itString: 'mutes the specified conversation',
          tag: 'MUTED',
          verb: 'mute'
        }
      ].forEach(({tag, verb, itString}) => {
        describe(`#${verb}()`, () => {
          it(itString, () => webex.internal.conversation[verb](conversation)
            .then((activity) => {
              assert.isActivity(activity);
            })
            .then(() => webex.internal.conversation.get(conversation))
            .then((c) => assert.include(c.tags, tag)));
        });
      });

      [
        {
          itString: 'unfavorites the specified conversation',
          setupVerb: 'favorite',
          tag: 'FAVORITE',
          verb: 'unfavorite'
        },
        {
          itString: 'unhides the specified conversation',
          setupVerb: 'hide',
          tag: 'HIDDEN',
          verb: 'unhide'
        },
        {
          itString: 'unlocks the specified conversation',
          setupVerb: 'lock',
          tag: 'LOCKED',
          verb: 'unlock'
        },
        {
          itString: 'unmutes the specified conversation',
          setupVerb: 'mute',
          tag: 'MUTED',
          verb: 'unmute'
        }
      ].forEach(({
        tag, verb, itString, setupVerb
      }) => {
        describe(`#${verb}()`, () => {
          beforeEach(() => webex.internal.conversation[setupVerb](conversation)
            .catch((reason) => {
              if (reason.statusCode !== 403) {
                throw reason;
              }
            }));

          it(itString, () => webex.internal.conversation[verb](conversation)
            .then((activity) => {
              assert.isActivity(activity);
            })
            .then(() => webex.internal.conversation.get(conversation))
            .then((c) => assert.notInclude(c.tags, tag)));
        });
      });

      describe('#setSpaceProperty()', () => {
        afterEach(() => { conversation = null; });
        describe('when the current user is a moderator', () => {
          it('sets announcement mode for the specified conversation', () => webex.internal.conversation.assignModerator(conversation)
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.lock(conversation))
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.setSpaceProperty(conversation, 'ANNOUNCEMENT'))
            .then((activity) => {
              assert.isActivity(activity);
            })
            .then(() => webex.internal.conversation.get(conversation))
            .then((c) => assert.include(c.tags, 'ANNOUNCEMENT')));
        });

        describe('when the current user is not a moderator', () => {
          it('fails to set announcement mode for the specified conversation', () => webex.internal.conversation.assignModerator(conversation)
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.lock(conversation))
            .catch(allowConflicts)
            .then(() => assert.isRejected(mccoy.webex.internal.conversation.setSpaceProperty(conversation, 'ANNOUNCEMENT')))
            .then((reason) => assert.instanceOf(reason, WebexHttpError.Forbidden)));
        });
      });

      describe('#unsetSpaceProperty()', () => {
        afterEach(() => { conversation = null; });
        describe('when the current user is a moderator', () => {
          it('unsets announcement mode for the specified conversation', () => webex.internal.conversation.assignModerator(conversation)
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.lock(conversation))
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.setSpaceProperty(conversation, 'ANNOUNCEMENT'))
            .then((activity) => {
              assert.isActivity(activity);
            })
            .then(() => webex.internal.conversation.unsetSpaceProperty(conversation, 'ANNOUNCEMENT'))
            .then(() => webex.internal.conversation.get(conversation))
            .then((c) => assert.notInclude(c.tags, 'ANNOUNCEMENT')));
        });

        describe('when the current user is not a moderator', () => {
          it('fails to unset announcement mode for the specified conversation', () => webex.internal.conversation.assignModerator(conversation)
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.lock(conversation))
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.setSpaceProperty(conversation, 'ANNOUNCEMENT'))
            .then((activity) => {
              assert.isActivity(activity);
            })
            .then(() => assert.isRejected(mccoy.webex.internal.conversation.unsetSpaceProperty(conversation, 'ANNOUNCEMENT')))
            .then((reason) => assert.instanceOf(reason, WebexHttpError.Forbidden)));
        });
      });

      describe('#removeAllMuteTags()', () => {
        it('removes all mute tags on the convo', () => webex.internal.conversation.muteMessages(conversation)
          .then(() => webex.internal.conversation.muteMentions(conversation))
          .then(() => webex.internal.conversation.removeAllMuteTags(conversation))
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_ON');
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_OFF');
            assert.notInclude(c.tags, 'MENTION_NOTIFICATIONS_ON');
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_OFF');
          }));

        it('removes all unmute tags on the convo', () => webex.internal.conversation.unmuteMentions(conversation)
          .then(() => webex.internal.conversation.unmuteMessages(conversation))
          .then(() => webex.internal.conversation.removeAllMuteTags(conversation))
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_ON');
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_OFF');
            assert.notInclude(c.tags, 'MENTION_NOTIFICATIONS_ON');
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_OFF');
          }));
      });

      describe('#muteMentions()', () => {
        it('mutes the specified conversation of Mentions only', () => webex.internal.conversation.muteMentions(conversation)
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.include(c.tags, 'MENTION_NOTIFICATIONS_OFF');
            assert.notInclude(c.tags, 'MENTION_NOTIFICATIONS_ON');
          }));
      });

      describe('#unmuteMentions()', () => {
        before(() => webex.internal.conversation.muteMentions(conversation));

        it('unmutes the specified conversation of Mentions', () => webex.internal.conversation.unmuteMentions(conversation)
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.include(c.tags, 'MENTION_NOTIFICATIONS_ON');
            assert.notInclude(c.tags, 'MENTION_NOTIFICATIONS_OFF');
          }));
      });

      describe('#muteMessages()', () => {
        it('mutes the specified conversation of Messages only', () => webex.internal.conversation.muteMessages(conversation)
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.include(c.tags, 'MESSAGE_NOTIFICATIONS_OFF');
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_ON');
          }));
      });

      describe('#unmuteMessages()', () => {
        before(() => webex.internal.conversation.muteMessages(conversation));

        it('unmutes the specified conversation of Messages only', () => webex.internal.conversation.unmuteMessages(conversation)
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.include(c.tags, 'MESSAGE_NOTIFICATIONS_ON');
            assert.notInclude(c.tags, 'MESSAGE_NOTIFICATIONS_OFF');
          }));
      });

      describe('#ignore()', () => {
        it('ignores the specified conversation', () => webex.internal.conversation.ignore(conversation)
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.include(c.tags, 'IGNORED');
          }));
      });

      describe('#unignore()', () => {
        before(() => webex.internal.conversation.ignore(conversation));

        it('ignores the specified conversation', () => webex.internal.conversation.unignore(conversation)
          .then(() => webex.internal.conversation.get(conversation))
          .then((c) => {
            assert.notInclude(c.tags, 'IGNORED');
          }));
      });
    });

    describe('verbs that update objects', () => {
      let conversation;

      before(() => {
        if (!conversation) {
          return webex.internal.conversation.create({displayName: 'displayName', participants})
            .then((c) => {
              conversation = c;
            });
        }

        return Promise.resolve();
      });

      describe('#acknowledge()', () => {
        it('acknowledges the specified activity', () => webex.internal.conversation.post(conversation, {displayName: 'A comment to acknowledge'})
          .then((activity) => mccoy.webex.internal.conversation.acknowledge(conversation, activity))
          .then((ack) => webex.internal.conversation.get(conversation, {activitiesLimit: 1})
            .then((c) => assert.equal(c.activities.items[0].url, ack.object.url))));
      });

      describe('#assignModerator()', () => {
        it('assigns a moderator to a conversation', () => webex.internal.conversation.assignModerator(conversation, spock)
          .then(() => webex.internal.conversation.get(conversation, {
            activitiesLimit: 5,
            includeParticipants: true
          }))
          .then((c) => {
            const moderators = c.participants.items.filter((p) => p.roomProperties && p.roomProperties.isModerator);

            assert.lengthOf(moderators, 1);
            assert.equal(moderators[0].id, spock.id);
          }));
      });

      describe('#delete()', () => {
        let sampleImageSmallOnePng = 'sample-image-small-one.png';

        before(() => fh.fetch(sampleImageSmallOnePng)
          .then((res) => {
            sampleImageSmallOnePng = res;
          }));

        it('deletes the current user\'s post', () => webex.internal.conversation.post(conversation, {displayName: 'Delete Me 1'})
          .then((a) => webex.internal.conversation.delete(conversation, a))
          .then(() => new Promise((resolve) => setTimeout(resolve, 2000)))
          .then(() => webex.internal.conversation.get(conversation, {activitiesLimit: 2}))
          .then((c) => {
            assert.equal(c.activities.items[0].verb, 'tombstone');
            assert.equal(c.activities.items[1].verb, 'delete');
          }));

        it('deletes the current user\'s share', () =>
          webex.internal.conversation.share(conversation, [sampleImageSmallOnePng])
            .then((a) => webex.internal.conversation.delete(conversation, a))
            .then(() => new Promise((resolve) => setTimeout(resolve, 2000)))
            .then(() => webex.internal.conversation.get(conversation, {activitiesLimit: 2}))
            .then((c) => {
              assert.equal(c.activities.items[0].verb, 'tombstone');
              assert.equal(c.activities.items[1].verb, 'delete');
            }));

        describe('when the current user is a moderator', () => {
          it('deletes any user\'s content', () => webex.internal.conversation.assignModerator(conversation)
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.lock(conversation))
            .catch(allowConflicts)
            .then(() => mccoy.webex.internal.conversation.post(conversation, {displayName: 'Delete Me 2'}))
            .then((a) => webex.internal.conversation.delete(conversation, a)));
        });

        describe('when the current user is not a moderator', () => {
          it('fails to delete other users\' content', () => webex.internal.conversation.assignModerator(conversation)
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.lock(conversation))
            .catch(allowConflicts)
            .then(() => webex.internal.conversation.post(conversation, {displayName: 'Delete Me 3'}))
            .then((a) => assert.isRejected(mccoy.webex.internal.conversation.delete(conversation, a)))
            .then((reason) => assert.instanceOf(reason, WebexHttpError.Forbidden)));
        });
      });

      describe('#addReaction', () => {
        it('adds a reaction', () => webex.internal.conversation.post(conversation, {displayName: 'React Me 1'})
          .then((activity) => webex.internal.conversation.addReaction(conversation, 'smiley', activity))
          .then((reaction) => {
            assert.equal(reaction.verb, 'add');
            assert.equal(reaction.object.objectType, 'reaction2');
            assert.equal(reaction.object.displayName, 'smiley');
          }));
      });

      describe('#deleteReaction', () => {
        it('deletes a reaction', () => webex.internal.conversation.post(conversation, {displayName: 'React Me 1'})
          .then((activity) => webex.internal.conversation.addReaction(conversation, 'smiley', activity))
          .then((reaction) => webex.internal.conversation.deleteReaction(conversation, reaction.id))
          .then((deleteReaction) => {
            assert.equal(deleteReaction.verb, 'delete');
            assert.equal(deleteReaction.object.verb, 'tombstone');
            assert.equal(deleteReaction.object.parent.type, 'reaction');
          }));
      });

      describe('#unassignModerator()', () => {
        it('removes a moderator from a conversation', () => webex.internal.conversation.assignModerator(conversation, spock)
          .catch(allowConflicts)
          .then(() => webex.internal.conversation.unassignModerator(conversation, spock))
          .then(() => webex.internal.conversation.get(conversation, {
            activitiesLimit: 5,
            includeParticipants: true
          }))
          .then((c) => {
            const moderators = c.participants.items.filter((p) => p.roomProperties && p.roomProperties.isModerator);

            assert.lengthOf(moderators, 0);
          }));
      });

      describe('#update()', () => {
        it('renames the specified conversation', () => webex.internal.conversation.update(conversation, {
          displayName: 'displayName2',
          objectType: 'conversation'
        })
          .then((c) => webex.internal.conversation.get({url: c.target.url}))
          .then((c) => assert.equal(c.displayName, 'displayName2')));
      });
    });
  });
});

function allowConflicts(reason) {
  if (!(reason instanceof WebexHttpError.BadRequest)) {
    throw reason;
  }
}
