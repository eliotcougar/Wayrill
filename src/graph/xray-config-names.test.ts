import { describe, expect, it } from 'vitest';
import { fixXrayCapitalization, inspectXrayCapitalization } from './xrayConfigNames';

describe('Schema-aware Xray capitalization repair', () => {
  it.each([
    '{"Observatory":{},"observatory":{}}',
    '{"outbounds":[{"protocol":"vless","streamSettings":{"tlsSettings":{},"TLSSETTINGS":{}}}]}',
    '{"routing":{"rules":[{"outboundTag":"a","OUTBOUNDTAG":"a"}]}}',
    '{"policy":{"levels":{"0":{"connIdle":1,"CONNIDLE":2}}}}',
    '{"dns":{"servers":[{"address":"localhost","ADDRESS":"localhost"}]}}',
  ])('refuses ambiguous aliases without choosing a value: %s', (text) => {
    expect(() => inspectXrayCapitalization(text)).toThrow('Ambiguous Xray fields');
    expect(() => fixXrayCapitalization(text)).toThrow('Resolve the duplicate names');
  });
});
