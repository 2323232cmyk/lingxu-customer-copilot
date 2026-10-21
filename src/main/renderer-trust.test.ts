import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl } from './renderer-trust';

describe('isTrustedRendererUrl', () => {
  it('allows only the exact development renderer URL', () => {
    const expected = 'http://localhost:5173/';
    expect(isTrustedRendererUrl(expected, expected)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/other', expected)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173.evil.test/', expected)).toBe(false);
  });

  it('rejects a different file even when it has the same renderer suffix', () => {
    const expected = 'file:///C:/app/resources/app.asar/.vite/renderer/main_window/index.html';
    expect(isTrustedRendererUrl(expected, expected)).toBe(true);
    expect(isTrustedRendererUrl('file:///C:/Users/Public/untrusted.html', expected)).toBe(false);
    expect(isTrustedRendererUrl(
      'file:///C:/Users/Public/renderer/main_window/index.html',
      expected,
    )).toBe(false);
  });
});
