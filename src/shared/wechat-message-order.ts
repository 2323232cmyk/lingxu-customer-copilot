const MIN_SEQUENCE = -(1n << 63n);
const MAX_SEQUENCE = (1n << 63n) - 1n;

/** SQLite int64 values must remain strings across the worker boundary. */
export const isWechatSortSequence = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^-?\d{1,19}$/u.test(value)) return false;
  const sequence = BigInt(value);
  return sequence >= MIN_SEQUENCE && sequence <= MAX_SEQUENCE;
};

export const compareWechatMessageOrder = (
  leftTime: string,
  rightTime: string,
  leftSequence?: string,
  rightSequence?: string,
): number => {
  const timeDifference = Date.parse(leftTime) - Date.parse(rightTime);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
  if (!isWechatSortSequence(leftSequence) || !isWechatSortSequence(rightSequence)) return 0;
  const left = BigInt(leftSequence);
  const right = BigInt(rightSequence);
  return left < right ? -1 : left > right ? 1 : 0;
};
