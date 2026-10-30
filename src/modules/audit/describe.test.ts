import { describe, expect, it } from 'vitest';
import { csvCell } from './audit.service.js';
import { describeAuditEvent, deviceSummary } from './describe.js';
import { AUDIT_ACTIONS, type AuditAction } from './models.js';

const event = (action: AuditAction, details: Record<string, unknown> = {}) => ({
  action,
  actorName: 'Asha',
  targetLabel: 'Neha',
  details,
});

describe('audit summaries', () => {
  it('describes every action as one sentence', () => {
    for (const action of Object.keys(AUDIT_ACTIONS) as AuditAction[]) {
      const sentence = describeAuditEvent(
        event(action, { role: 'agent', from: 'agent', to: 'admin' }),
      );
      expect(sentence, action).toMatch(/^[A-Z].*\.$/);
    }
  });

  it.each([
    [
      event('member.role_changed', { from: 'agent', to: 'supervisor' }),
      "Asha changed Neha's role from Agent to Supervisor.",
    ],
    [event('member.invited', { role: 'admin' }), 'Asha invited Neha as Admin.'],
    [event('member.joined', {}), 'Asha joined as a member.'],
    [
      event('workspace.two_factor_requirement_changed', { required: true }),
      'Asha required two-step verification for everyone.',
    ],
    [
      event('sign_in.succeeded', { method: 'recovery_code' }),
      'Asha signed in with a recovery code.',
    ],
    [
      event('sign_in.succeeded', { method: 'two_factor' }),
      'Asha signed in with a code from their authenticator app.',
    ],
    [event('sign_in.succeeded', {}), 'Asha signed in.'],
    [{ ...event('member.deactivated'), targetLabel: null }, 'Asha deactivated someone.'],
  ])('%#: %s', (input, expected) => {
    expect(describeAuditEvent(input)).toBe(expected);
  });
});

describe('device summary', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    ['curl/8.4.0', 'Unknown device'],
    [null, 'Unknown device'],
  ])('%s → %s', (agent, expected) => {
    expect(deviceSummary(agent)).toBe(expected);
  });
});

describe('CSV cells', () => {
  it.each([
    ['plain', 'plain'],
    ['a, b', '"a, b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-2', "'-2"],
    ['@cmd', "'@cmd"],
    [null, ''],
  ])('%j → %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});
