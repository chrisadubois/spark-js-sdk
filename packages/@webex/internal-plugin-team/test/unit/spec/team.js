/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

/* eslint-disable no-underscore-dangle */
import {assert} from '@webex/test-helper-chai';
import MockWebex from '@webex/test-helper-mock-webex';
import sinon from 'sinon';
import Team from '@webex/internal-plugin-team';
import User from '@webex/internal-plugin-user';
import uuid from 'uuid';

const TEAM_URL = 'https://example.com/team';
const TEAM_DISPLAY_NAME = 'test';

describe('plugin-team', () => {
  describe('Team', () => {
    let webex;

    beforeEach(() => {
      webex = new MockWebex({
        children: {
          team: Team,
          user: User
        }
      });

      webex.internal.user.recordUUID = sinon.spy();
    });

    describe('#create()', () => {
      it('requires a displayName', () => assert.isRejected(webex.internal.team.create({}), /`params.displayName` is required/));

      it('requires a participants attribute', () => assert.isRejected(webex.internal.team.create({displayName: 'test'}), /`params.participants` is required/));

      it('requires a participants array', () => assert.isRejected(webex.internal.team.create({displayName: 'test', participants: []}), /`params.participants` is required/));
    });

    describe('#createConversation()', () => {
      const url = TEAM_URL;
      const displayName = TEAM_DISPLAY_NAME;

      it('requires a URL',
        () => assert.isRejected(
          webex.internal.team.createConversation({}, {}),
          /`team.url` is required/
        ));

      it('requires a displayName',
        () => assert.isRejected(
          webex.internal.team.createConversation({url}, {}),
          /`params.displayName` is required/
        ));

      it('requires a team object with a general conversation',
        () => assert.isRejected(
          webex.internal.team.createConversation({url}, {displayName}),
          /`team.generalConversationUuid` must be present/
        ));
    });

    describe('#get()', () => {
      it('requires a team url', () =>
        assert.isRejected(
          webex.internal.team.get({}),
          /`team.url` is required/
        ));
    });

    describe('#listConversations()', () => {
      it('requires a team url', () =>
        assert.isRejected(
          webex.internal.team.listConversations({}),
          /`team.url` is required/
        ));
    });

    describe('#prepareTeamConversation()', () => {
      it('requires a KRO', () => assert.isRejected(webex.internal.team._prepareTeamConversation({}), /Team general conversation must have a KRO/));
    });

    describe('#recordUUIDs', () => {
      it('resolves if there are no teamMembers', () => webex.internal.team._recordUUIDs({})
        .then(() => assert.equal(webex.internal.user.recordUUID.callCount, 0)));

      it('resolves if there isn\'t teamMembers.items', () => webex.internal.team._recordUUIDs({teamMembers: {}})
        .then(() => assert.equal(webex.internal.user.recordUUID.callCount, 0)));

      it('resolves if there is a LYRA_SPACE user', () => {
        const user = {
          id: uuid.v4(),
          type: 'LYRA_SPACE'
        };

        return webex.internal.team._recordUUIDs({teamMembers: {[user.id]: user}})
          .then(() => assert.equal(webex.internal.user.recordUUID.callCount, 0));
      });
    });
  });
});
