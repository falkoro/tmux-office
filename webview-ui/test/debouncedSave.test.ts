import assert from 'node:assert/strict';

import { afterEach, describe, test, vi } from 'vitest';

import { debouncedSave } from '../src/hooks/debouncedSave.js';

describe('debouncedSave', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('sends only the last of a burst, once the delay has passed', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const saver = debouncedSave<string>((v) => sent.push(v), 500);
    saver.save('a');
    vi.advanceTimersByTime(400);
    saver.save('b');
    vi.advanceTimersByTime(400);
    assert.deepEqual(sent, []);
    vi.advanceTimersByTime(100);
    assert.deepEqual(sent, ['b']);
  });

  test('flush sends a waiting save at once, and only once', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const saver = debouncedSave<string>((v) => sent.push(v), 500);
    saver.save('edit');
    saver.flush();
    assert.deepEqual(sent, ['edit']);
    vi.advanceTimersByTime(1000);
    saver.flush();
    assert.deepEqual(sent, ['edit']);
  });

  test('cancel drops a waiting save', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const saver = debouncedSave<string>((v) => sent.push(v), 500);
    saver.save('edit');
    saver.cancel();
    vi.advanceTimersByTime(1000);
    saver.flush();
    assert.deepEqual(sent, []);
  });
});
