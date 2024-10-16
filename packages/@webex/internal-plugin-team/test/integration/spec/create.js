/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import '@webex/internal-plugin-device';
import '@webex/internal-plugin-team';

import {assert} from '@webex/test-helper-chai';
import WebexCore from '@webex/webex-core';
import {find, findLast} from 'lodash';
import testUsers from '@webex/test-helper-test-users';
import uuid from 'uuid';

describe('plugin-team', () => {
  let displayName, kirk, participants, webex, spock, summary, team;

  before(() => testUsers.create({count: 3})
    .then((users) => {
      participants = [kirk, spock] = users;

      kirk.webex = webex = new WebexCore({
        credentials: {
          authorization: kirk.token
        },
        config: {
          conversation: {
            keepEncryptedProperties: true
          }
        }
      });

      return webex.internal.mercury.connect();
    }));

  beforeEach(() => {
    displayName = `team-conv-name-${uuid.v4()}`;
    summary = `team-summary-${uuid.v4()}`;
  });

  after(() => kirk && kirk.webex.internal.mercury.disconnect());

  describe('#create()', () => {
    it('creates a team with a multiple participants', () => webex.internal.team.create({displayName, participants: [kirk, spock]})
      .then((team) => {
        assert.isInternalTeam(team);
        assert.isNewEncryptedInternalTeam(team);
        assert.lengthOf(team.teamMembers.items, 2);

        // Kirk created the team and is the moderator, Spock is not.
        const kirkEntry = find(team.teamMembers.items, {id: kirk.id});

        assert.isDefined(kirkEntry);
        assert.isDefined(kirkEntry.roomProperties.isModerator);

        const spockEntry = find(team.teamMembers.items, {id: spock.id});

        assert.isDefined(spockEntry);
        assert.isUndefined(spockEntry.roomProperties);
      }));

    it('creates a team with a name and summary', () => webex.internal.team.create({displayName, summary, participants: [kirk]})
      .then((team) => {
        assert.isInternalTeam(team);
        assert.isNewEncryptedInternalTeam(team);
        assert.lengthOf(team.teamMembers.items, 1);

        assert.equal(team.displayName, displayName);
        assert.equal(team.summary, summary);
      }));

    it('creates a team with a name but without a summary', () => webex.internal.team.create({displayName, participants: [kirk]})
      .then((team) => {
        assert.isInternalTeam(team);
        assert.isNewEncryptedInternalTeam(team);
        assert.lengthOf(team.teamMembers.items, 1);

        assert.equal(team.displayName, displayName);
        assert.isUndefined(team.summary);
      }));
  });

  describe('#createConversation()', () => {
    before(() => webex.internal.team.create({displayName, participants})
      .then((t) => {
        team = t;
      }));

    beforeEach(() => {
      displayName = `team-conv-name-${uuid.v4()}`;
    });

    it('creates a team conversation with a single participant', () => webex.internal.team.createConversation(team, {displayName, participants: [kirk]})
      .then((tc) => {
        assert.isInternalTeamConversation(tc);
        assert.equal(tc.displayName, displayName);

        assert.lengthOf(tc.participants.items, 1);
      }));

    it('creates a team conversation with multiple participants', () => webex.internal.team.createConversation(team, {displayName, participants: [kirk, spock]})
      .then((tc) => {
        assert.isInternalTeamConversation(tc);
        assert.lengthOf(tc.participants.items, 2);
      }));

    it('creates a team conversation containing all team members via `includeAllTeamMembers` parameter', () => webex.internal.team.createConversation(team, {displayName, participants: [kirk]}, {includeAllTeamMembers: true})
      .then((tc) => {
        assert.isInternalTeamConversation(tc);
        assert.lengthOf(tc.participants.items, 3);
      }));

    it('decrypts the \'add\' activity appended to the general conversation after team room is created', () => webex.internal.team.createConversation(team, {displayName, participants: [kirk]}, {includeAllTeamMembers: true})
      .then((tc) => webex.internal.conversation.get(find(team.conversations.items, {id: team.generalConversationUuid}), {
        activitiesLimit: 10
      })
        .then((teamGeneral) => {
          assert.isConversation(teamGeneral);
          const addActivity = findLast(teamGeneral.activities.items, (activity) => activity.verb === 'add' && activity.object.objectType === 'conversation' && activity.object.id === tc.id);

          assert.isDefined(addActivity);
          assert.equal(addActivity.object.displayName, tc.displayName);

          assert.isDefined(addActivity.object.encryptedDisplayName);
          assert.notEqual(addActivity.object.displayName, addActivity.object.encryptedDisplayName);
          assert.equal(addActivity.object.displayName, displayName);
        })));
  });
});
