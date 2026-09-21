import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFromClaudeResponse } from '../src/providers';

test('textFromClaudeResponse joins every text block (a long answer may arrive split)', () => {
    assert.equal(
        textFromClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"steps": [' }, { type: 'text', text: ']}' }] }),
        '{"steps": []}',
        'taking only content[0] truncated the JSON');
});

test('an empty or blockless response is a readable error, not a TypeError on undefined', () => {
    assert.throws(() => textFromClaudeResponse({ stop_reason: 'end_turn', content: [] }), /contained no text/);
    assert.throws(() => textFromClaudeResponse({}), /contained no text/);
    assert.throws(() => textFromClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'tool_use' }] }), /contained no text/);
});

test('a stop reason that cut the answer short is reported instead of returning partial text', () => {
    assert.throws(
        () => textFromClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"steps": [1,' }] }),
        /stopped early.*max_tokens/);
    assert.equal(textFromClaudeResponse({ stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'ok' }] }), 'ok');
    assert.equal(
        textFromClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'tool_use' }, { type: 'text', text: 'done' }] }),
        'done',
        'non-text blocks are skipped, not assumed to be the answer');
});
