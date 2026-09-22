// SPDX-License-Identifier: Apache-2.0

/**
 * Submitting a change.
 *
 * Whether a change may be submitted is the server's decision, made from its own
 * submit rules at the moment it is asked. So this asks, and reports the answer;
 * there is deliberately no readiness check first. A local verdict could only
 * agree with the server, which adds nothing, or disagree with it, and then the
 * local one is the one that is wrong. A refusal comes back as the server worded
 * it -- see `restSubmit` in rest.js.
 *
 * Submitting records no vote. Gerrit merges what its rules say has been approved,
 * and refuses a change they do not, so the ability to submit is the ability to
 * ask a server that will refuse.
 */

import { restSubmit } from './rest.js';

/**
 * @typedef {Object} Submitted
 * @property {number} number
 * @property {string|null} changeId
 * @property {string|null} project
 * @property {string|null} branch
 * @property {string|null} topic
 * @property {string|null} subject
 * @property {string} status   as the server reported it, normally MERGED
 */

/**
 * Submit one change. Gerrit decides what has to be submitted with it -- the
 * changes it depends on, or the rest of its topic where the server submits
 * topics whole -- and submits them together or not at all.
 *
 * @param {import('./session.js').Session} session
 * @param {number|string} change   change number
 * @returns {Promise<Submitted>}
 */
export async function submitChange(session, change) {
  const target = await session.restTarget();
  /** @type {any} */
  const info = await restSubmit(target, change);
  const number = Number(info?._number);
  return {
    number: Number.isFinite(number) ? number : Number(change),
    changeId: info?.change_id ?? null,
    project: info?.project ?? null,
    branch: info?.branch ?? null,
    topic: info?.topic ?? null,
    subject: info?.subject ?? null,
    status: String(info?.status ?? 'UNKNOWN'),
  };
}
