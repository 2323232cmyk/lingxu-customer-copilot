export const isTrustedRendererUrl = (sourceUrl: string, expectedRendererUrl: string): boolean => {
  let source: URL;
  let expected: URL;
  try {
    source = new URL(sourceUrl);
    expected = new URL(expectedRendererUrl);
  } catch {
    return false;
  }

  return source.href === expected.href;
};
